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

  # Built by hand rather than taken from the resource's `arn` attribute, because the
  # two IAM forms differ by a suffix: CreateLogStream and PutLogEvents are authorized
  # on `...:log-group:NAME:log-stream:STREAM`, DescribeLogStreams on the group itself.
  # `NAME:*` covers the first; the bare `NAME` covers the second.
  worker_log_group_arn = "arn:${local.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:${aws_cloudwatch_log_group.worker.name}"

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
          # Worker logs, which have to reach CloudWatch because the instance that
          # wrote them is gone by the time anyone reads them: per-stage-ephemeral
          # terminates the worker when its stage ends and the journal goes with it.
          #
          # DescribeLogStreams as well as the two writes — the CloudWatch agent
          # looks a stream up before it appends to it, and without this the agent
          # fails with AccessDenied and ships nothing at all.
          #
          # NO logs:CreateLogGroup, deliberately. The group is Terraform's, with a
          # retention period on it, so a worker cannot conjure a group that keeps
          # every byte forever and that nobody knows to look in.
          Effect   = "Allow"
          Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
          Resource = [local.worker_log_group_arn, "${local.worker_log_group_arn}:*"]
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

# ---------------------------------------------------------------------------
# Where a worker's log lives after the worker does not.
#
# ONE group per deployment, with the environment id in the STREAM name rather than
# in the group name. A group per environment would read better, but environments are
# runtime objects — an operator creates them through the API, they live in the
# environment registry table, and Terraform has no way to enumerate them. The only
# way to get a group per environment is to let the instance create its own, which
# means granting logs:CreateLogGroup and accepting groups with no retention that
# accumulate forever. Predictability is not lost: streams are
# `<environmentId>/<instanceId>`, so an operator filters by environment prefix and
# gets exactly the workers of that environment.
#
# Terraform owning the group is also what makes the grant above tight.
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "worker" {
  name = "/aidlc/worker/${var.project_name}-${var.environment}"
  # A worker log is read while debugging the stage that wrote it, or within a day or
  # two of it. Two weeks in dev is generous for that and keeps the bill bounded.
  retention_in_days = var.environment == "prod" ? 30 : 14
  tags              = var.tags
}
