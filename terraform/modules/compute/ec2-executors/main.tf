# Ingredients for EC2 workers — deliberately NOT a launch template.
#
# A launch template is a build artifact of publishing an EC2 environment
# revision: the environments lambda creates one per revision from the operator's
# submitted spec (AMI, architecture, instance families, volume), exactly as it
# already creates an AgentCore runtime per revision in
# lambda/environments/status.js. Putting a template here would be wrong twice
# over — it varies per environment, and a published revision needs a FROZEN
# launch identity so republishing cannot move a running intent's placement.
#
# What Terraform owns is what every worker shares regardless of environment: the
# instance role and profile, and the values the templates reference. The worker
# runtime itself is baked into the AMI by scripts/provision-worker-ami.sh, so
# there is nothing to ship at boot and no bundle bucket. These values are passed
# to the environments lambda as env vars, the same way MANAGED_RUNTIME_ROLE_ARN
# and MANAGED_RUNTIME_SUBNETS already are.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix

  credential_broker_function_arn = "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-credential-broker-${var.environment}"
  source_control_function_arn    = "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-source-control-${var.environment}"
  scheduler_function_arn         = "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-scheduler-${var.environment}"

  orchestrator_function_arns = [
    "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-v2-orchestrator-${var.environment}",
    "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-v2-orchestrator-${var.environment}:*",
  ]
}

# ---------------------------------------------------------------------------
# The worker instance role.
#
# Mirrors the AgentCore runtime role (terraform/modules/compute/agentcore),
# because a worker runs the SAME container commands and therefore needs the same
# access: Neptune, the process table, artifacts, MCP secrets, the credential
# broker, the websocket, and the durable callback API. Differences:
#   - no ECR image pull (the runtime is in the AMI, not a container registry);
#   + scheduler invoke, for issue-grant at claim time.
# Deliberately NO model-invocation permissions: agent auth is token-based through
# the broker, and that must stay the only path on a worker too.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "executor" {
  name = "${var.project_name}-executor-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.${local.dns_suffix}" }
    }]
  })

  tags = var.tags
}

resource "aws_iam_instance_profile" "executor" {
  name = "${var.project_name}-executor-${var.environment}"
  role = aws_iam_role.executor.name
  tags = var.tags
}

# Managed by SSM so an operator can get a shell on a stuck build host without
# any inbound path or SSH key, which is how the dev host itself is reached.
resource "aws_iam_role_policy_attachment" "executor_ssm" {
  role       = aws_iam_role.executor.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "executor" {
  name = "executor"
  role = aws_iam_role.executor.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          # Git and agent credentials just-in-time; provider operations through
          # the token-owning service. Same as the AgentCore runtime.
          Effect = "Allow"
          Action = ["lambda:InvokeFunction"]
          Resource = [
            local.credential_broker_function_arn,
            local.source_control_function_arn,
            local.scheduler_function_arn,
          ]
        },
        {
          Effect   = "Allow"
          Action   = ["neptune-db:ReadDataViaQuery", "neptune-db:WriteDataViaQuery", "neptune-db:DeleteDataViaQuery", "neptune-db:connect"]
          Resource = "arn:${local.partition}:neptune-db:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:${var.neptune_cluster_resource_id}/*"
        },
        {
          # Mirrors the AgentCore runtime policy, because an EC2 worker runs the
          # same handler map — including create-workflow-checkpoint, whose
          # TransactWriteItems is guarded by a ConditionCheck on the execution META
          # item and therefore needs ConditionCheckItem as well as PutItem.
          Effect = "Allow"
          Action = [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:ConditionCheckItem",
          ]
          Resource = compact([
            var.v2_executions_table_arn,
            "${var.v2_executions_table_arn}/index/*",
            var.blocks_table_arn,
            var.blocks_table_arn != "" ? "${var.blocks_table_arn}/index/*" : "",
            var.connections_table_arn,
            var.connections_table_arn != "" ? "${var.connections_table_arn}/index/*" : "",
          ])
        },
        {
          Effect   = "Allow"
          Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"]
          Resource = [var.artifacts_bucket_arn, "${var.artifacts_bucket_arn}/*"]
        },
        {
          # The stage verdict. A worker completes the orchestrator's durable
          # callback itself — this is why a Valkey outage cannot lose a verdict.
          Effect = "Allow"
          Action = [
            "lambda:SendDurableExecutionCallbackSuccess",
            "lambda:SendDurableExecutionCallbackFailure",
            "lambda:SendDurableExecutionCallbackHeartbeat",
          ]
          Resource = local.orchestrator_function_arns
        },
        {
          Effect = "Allow"
          Action = ["ssm:GetParameter", "ssm:GetParameters"]
          Resource = [
            "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/mcp-secrets/*",
            "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/projects/*/mcp-secrets/*",
            "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/cli-models",
            "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/${var.environment}/tier-models",
          ]
        },
        {
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"]
          Resource = "arn:${local.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:${aws_cloudwatch_log_group.executor.name}*"
        },
      ],
      var.websocket_execution_arn != "" ? [
        {
          Effect   = "Allow"
          Action   = ["execute-api:ManageConnections"]
          Resource = "${var.websocket_execution_arn}/*"
        },
      ] : [],
    )
  })
}

resource "aws_cloudwatch_log_group" "executor" {
  name              = "/aidlc/${var.project_name}-executor-${var.environment}"
  retention_in_days = var.environment == "prod" ? 30 : 7
  tags              = var.tags
}
