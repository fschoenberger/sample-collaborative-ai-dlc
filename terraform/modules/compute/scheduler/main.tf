data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  dns_suffix = data.aws_partition.current.dns_suffix

  lambda_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.${local.dns_suffix}" }
    }]
  })

  shared_dir = "${path.module}/../../../../lambda/shared"
  shared_sources_hash = sha256(join("", [
    for f in sort(fileset(local.shared_dir, "**/*.{js,mjs,cjs,json}")) :
    filesha256("${local.shared_dir}/${f}")
  ]))

  # Two AZs is enough for a control-plane cache and keeps the subnet carve small.
  cache_azs = slice(var.availability_zones, 0, min(2, length(var.availability_zones)))

  orchestrator_function_arns = [
    "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-v2-orchestrator-${var.environment}",
    "arn:${local.partition}:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-v2-orchestrator-${var.environment}:*",
  ]
}

# ---------------------------------------------------------------------------
# Networking. Dedicated subnets high in the VPC range (offset 210) so they never
# collide with networking's public (0..), private (10..) or the AgentCore
# subnets (200..).
# ---------------------------------------------------------------------------

resource "aws_subnet" "cache" {
  count = length(local.cache_azs)

  vpc_id            = var.vpc_id
  availability_zone = local.cache_azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 210)

  tags = merge(var.tags, {
    Name = "${var.project_name}-scheduler-cache-${var.environment}-${count.index + 1}"
  })
}

resource "aws_route_table_association" "cache" {
  count = length(aws_subnet.cache)

  subnet_id      = aws_subnet.cache[count.index].id
  route_table_id = element(var.private_route_table_ids, count.index)
}

# The cache accepts only from the scheduler and from workers. Deliberately NOT
# the whole VPC CIDR: Valkey holds placement state and a lease is an
# authorization, so the blast radius of a compromised unrelated task should not
# include it.
resource "aws_security_group" "cache" {
  name_prefix = "${var.project_name}-scheduler-cache-${var.environment}"
  description = "Valkey for the placement scheduler; ingress only from the scheduler and workers"
  vpc_id      = var.vpc_id

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "clients" {
  name_prefix = "${var.project_name}-scheduler-clients-${var.environment}"
  description = "Attached to the scheduler Lambda ENIs and to workers; egress only"
  vpc_id      = var.vpc_id

  egress {
    description = "All egress (Valkey in-VPC, AWS APIs via NAT or endpoints)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_clients" {
  security_group_id            = aws_security_group.cache.id
  referenced_security_group_id = aws_security_group.clients.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Valkey from the scheduler and workers"
}

# ---------------------------------------------------------------------------
# ElastiCache Serverless (Valkey).
#
# Serverless rather than a provisioned cluster: this is a control-plane cache
# whose load is a handful of operations per stage, and node sizing would be pure
# guesswork. ElastiCache rather than MemoryDB because nothing here is a system of
# record — execution state lives in DynamoDB and instance truth is
# DescribeInstances by tag, so the reconciler can rebuild after a total cache
# loss. Paying MemoryDB's durability premium would be paying twice for a
# guarantee the durable orchestrator already provides.
#
# NOTE: Serverless is always cluster-mode-enabled, which is why every key in
# lambda/shared/valkey/keys.js carries a hash tag.
# ---------------------------------------------------------------------------

resource "aws_elasticache_serverless_cache" "scheduler" {
  engine = "valkey"
  name   = "${var.project_name}-scheduler-${var.environment}"

  description          = "Placement registry, job streams and leases for the stage scheduler"
  major_engine_version = "8"
  security_group_ids   = [aws_security_group.cache.id]
  subnet_ids           = aws_subnet.cache[*].id

  # A dev cache should never quietly become expensive. The registry is small
  # (worker rows, short streams), so a low ceiling is a real guardrail rather
  # than a limit anything legitimate will hit.
  cache_usage_limits {
    data_storage {
      maximum = var.environment == "prod" ? 20 : 2
      unit    = "GB"
    }
    ecpu_per_second {
      maximum = var.environment == "prod" ? 50000 : 5000
    }
  }

  tags = var.tags
}

# ---------------------------------------------------------------------------
# The scheduler Lambda.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "scheduler" {
  name               = "${var.project_name}-scheduler-${var.environment}"
  assume_role_policy = local.lambda_assume_role_policy
  tags               = var.tags
}

# VPC-attached, so it needs the ENI management permissions.
resource "aws_iam_role_policy_attachment" "scheduler_vpc" {
  role       = aws_iam_role.scheduler.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "scheduler" {
  name = "scheduler"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Placement reads: the launch spec and pinned launch template of a
        # published revision.
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = [var.environment_registry_table_arn, "${var.environment_registry_table_arn}/index/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"]
        Resource = [var.v2_executions_table_arn, "${var.v2_executions_table_arn}/index/*"]
      },
      {
        # Provisioning. Scoped by tag on the mutating calls so the scheduler can
        # only ever terminate instances it created.
        Effect   = "Allow"
        Action   = ["ec2:CreateFleet", "ec2:RunInstances", "ec2:CreateTags"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:DescribeInstances", "ec2:DescribeImages", "ec2:DescribeSubnets", "ec2:DescribeLaunchTemplates", "ec2:DescribeLaunchTemplateVersions", "ec2:DescribeInstanceTypes"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:TerminateInstances"]
        Resource = "*"
        Condition = {
          StringEquals = { "ec2:ResourceTag/aidlc:scheduler" = "worker" }
        }
      },
      {
        # CreateFleet hands the instance profile to the instance.
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = var.executor_role_arn
        Condition = {
          StringEquals = { "iam:PassedToService" = "ec2.${local.dns_suffix}" }
        }
      },
      {
        # The wake provisioner. No model permissions: agent auth is token-based
        # through the credential broker, exactly as for the runtime itself.
        Effect = "Allow"
        Action = ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession"]
        Resource = [
          var.agentcore_runtime_arn,
          "${var.agentcore_runtime_arn}/*",
          "arn:${local.partition}:bedrock-agentcore:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:runtime/*",
        ]
      },
      {
        # Mints agent credential grants at claim time (see the scheduler's
        # issue-grant action). The 300s grant TTL is why issuance lives here and
        # not in the orchestrator.
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:${local.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${var.agent_credential_grant_secret_param_name}"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"]
        Resource = "arn:${local.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-scheduler-${var.environment}*"
      },
    ]
  })
}

module "scheduler_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = "${var.project_name}-scheduler-${var.environment}"
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  # A placement is a CreateFleet call plus a few Valkey round trips. The
  # reconcile sweep is the long pole and still finishes in seconds.
  timeout       = 120
  artifacts_dir = "builds/scheduler"

  source_path = [{
    path = "${path.module}/../../../../lambda/scheduler"
    commands = [
      "cd ../.. && npm run build -w scheduler -- --outdir=../../terraform/builds/scheduler/source",
      ":zip terraform/builds/scheduler/source",
    ]
  }]
  hash_extra = local.shared_sources_hash

  create_role = false
  lambda_role = aws_iam_role.scheduler.arn

  vpc_subnet_ids         = aws_subnet.cache[*].id
  vpc_security_group_ids = [aws_security_group.clients.id]

  cloudwatch_logs_retention_in_days = var.environment == "prod" ? 30 : 7

  environment_variables = {
    ENVIRONMENT                         = var.environment
    PROJECT_NAME                        = var.project_name
    VALKEY_HOST                         = aws_elasticache_serverless_cache.scheduler.endpoint[0].address
    VALKEY_PORT                         = tostring(aws_elasticache_serverless_cache.scheduler.endpoint[0].port)
    ENVIRONMENT_REGISTRY_TABLE          = var.environment_registry_table_name
    AGENTCORE_RUNTIME_ARN               = var.agentcore_runtime_arn
    AGENT_CREDENTIAL_GRANT_SECRET_PARAM = var.agent_credential_grant_secret_param_name
    LEASE_IDLE_MS                       = tostring(var.lease_idle_ms)
    EXECUTOR_SUBNET_IDS                 = join(",", aws_subnet.cache[*].id)
    EXECUTOR_INSTANCE_PROFILE_ARN       = var.executor_instance_profile_arn
    # Read by the reconciler's queue sweep to tell a deleted execution from an
    # unreadable one: the first means the queued entry is a corpse and must go, the
    # second means keep it. Without this the sweep could only ever do the latter.
    V2_PROCESS_TABLE                    = var.v2_executions_table_name
  }
}

# The orchestrator invokes the scheduler; the worker invokes it for issue-grant.
resource "aws_lambda_permission" "orchestrator_invoke" {
  statement_id  = "AllowOrchestratorInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.scheduler_lambda.lambda_function_name
  principal     = "lambda.${local.dns_suffix}"
  source_arn    = local.orchestrator_function_arns[0]
}

# ---------------------------------------------------------------------------
# The reconcile sweep. Abandoned leases, bootstrap timeouts, lifetime caps and
# orphan instances. The orphan check is what makes the cache disposable, so this
# rule is not optional decoration.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "reconcile" {
  name                = "${var.project_name}-scheduler-reconcile-${var.environment}"
  description         = "Periodic placement reconcile: leases, timeouts, lifetimes, orphan instances"
  schedule_expression = "rate(${var.reconcile_interval_minutes} minutes)"
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "reconcile" {
  rule      = aws_cloudwatch_event_rule.reconcile.name
  target_id = "scheduler"
  arn       = module.scheduler_lambda.lambda_function_arn
  input     = jsonencode({ action = "reconcile" })
}

resource "aws_lambda_permission" "reconcile" {
  statement_id  = "AllowReconcileSchedule"
  action        = "lambda:InvokeFunction"
  function_name = module.scheduler_lambda.lambda_function_name
  principal     = "events.${local.dns_suffix}"
  source_arn    = aws_cloudwatch_event_rule.reconcile.arn
}
