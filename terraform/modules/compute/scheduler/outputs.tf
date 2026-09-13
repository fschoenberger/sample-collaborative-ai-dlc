output "function_name" {
  description = "Scheduler Lambda name — the orchestrator and workers invoke this"
  value       = module.scheduler_lambda.lambda_function_name
}

output "function_arn" {
  description = "Scheduler Lambda ARN"
  value       = module.scheduler_lambda.lambda_function_arn
}

output "valkey_host" {
  description = "Valkey endpoint address. Workers connect directly; only the orchestrator goes through the Lambda."
  value       = aws_elasticache_serverless_cache.scheduler.endpoint[0].address
}

output "valkey_port" {
  description = "Valkey endpoint port"
  value       = aws_elasticache_serverless_cache.scheduler.endpoint[0].port
}

output "client_security_group_id" {
  description = "Security group that may reach Valkey. Attach to workers as well as the scheduler."
  value       = aws_security_group.clients.id
}

output "subnet_ids" {
  description = "Private subnets used by the scheduler and available to workers"
  value       = aws_subnet.cache[*].id
}
