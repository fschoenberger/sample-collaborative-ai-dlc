variable "project_name" {
  description = "Project name used in resource names"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
}

variable "neptune_cluster_resource_id" {
  description = "Neptune cluster resource id for neptune-db IAM"
  type        = string
}

variable "v2_executions_table_arn" {
  description = "v2 process/state table ARN"
  type        = string
}

variable "blocks_table_arn" {
  description = "Blocks table ARN (read)"
  type        = string
  default     = ""
}

variable "connections_table_arn" {
  description = "Websocket connections table ARN"
  type        = string
  default     = ""
}

variable "artifacts_bucket_arn" {
  description = "Artifacts bucket ARN (block bodies, methodology snapshot)"
  type        = string
}

variable "websocket_execution_arn" {
  description = "Websocket API execution ARN for live output; empty disables the grant"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to resources"
  type        = map(string)
  default     = {}
}
