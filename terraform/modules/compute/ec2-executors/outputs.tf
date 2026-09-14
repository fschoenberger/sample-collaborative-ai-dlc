output "instance_profile_arn" {
  description = "Instance profile the per-revision launch templates attach to workers"
  value       = aws_iam_instance_profile.executor.arn
}

output "role_arn" {
  description = "Worker instance role ARN — the scheduler needs it for iam:PassRole"
  value       = aws_iam_role.executor.arn
}

output "log_group_name" {
  description = "Log group every worker ships its runner log to; the environments lambda templates it into the CloudWatch agent config in user-data"
  value       = aws_cloudwatch_log_group.worker.name
}
