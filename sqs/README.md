# CrewCam SQS Worker with ECS Auto-Scaling

This SQS worker processes file download and ZIP creation jobs with automatic scaling on AWS ECS based on queue depth.

## Architecture Overview

```
Frontend → Backend → SQS → Worker (Fargate - Scale to Zero)
                              ↓
                             S3
                              ↓
                       Signed URL
                              ↓
                       SendGrid Email
```

- **Worker**: Node.js application that polls SQS for jobs
- **Container**: Docker container running on ECS Fargate
- **Auto-scaling**: Scales from 0 to 10 tasks based on:
  - SQS queue depth (automatic scale-up when messages arrive)
  - Scale to zero when queue is empty (no charges when idle)
- **Parallel Processing**: Multiple workers process messages concurrently when needed
- **Cost Optimization**: $0/month when idle, pay only when processing

## How Auto-Scaling Works

1. **Baseline**: 0 tasks when idle (no charges)
2. **Scale Up**: Automatically starts tasks when messages arrive
3. **Scale Down**: Returns to 0 after processing (5 min cooldown)
4. **Maximum**: Up to 10 concurrent workers for heavy loads

### Example Scaling Scenario:
- Queue empty → 0 workers ($0 cost)
- 1 message arrives → Scales to 1 worker
- 25 messages arrive → Scales to 5 workers (25÷5)
- 50 messages arrive → Scales to 10 workers (max)
- Queue empties → Scales back to 0 workers

## Prerequisites

1. AWS CLI configured
2. Docker installed
3. AWS resources:
   - VPC with public subnets
   - SQS queue: `zip-jobs-queue`
   - S3 bucket: `crewcam-downloads`
   - SendGrid account with API key

## Setup Instructions

### 1. Store Secrets in AWS Secrets Manager

```bash
cd scripts
./setup-secrets.sh
```

### 2. Create ECS Infrastructure

```bash
./setup-infrastructure.sh
```

You'll be prompted for:
- VPC ID
- Subnet IDs (comma-separated)
- ECS Cluster name (optional)

### 3. Build and Deploy

```bash
./deploy.sh
```

This will:
1. Build Docker image
2. Push to ECR
3. Update ECS service
4. Deploy with auto-scaling enabled

### 4. Monitor the Service

```bash
./monitor.sh
```

Shows real-time:
- Running tasks count
- Queue depth
- Task status

## Configuration Files

### `Dockerfile`
- Base image: Node.js 20 Alpine
- Non-root user for security
- Production dependencies only

### `ecs-task-definition.json`
- CPU: 512 units (0.5 vCPU)
- Memory: 1024 MB
- Secrets from AWS Secrets Manager
- CloudWatch logging

### `ecs-service-autoscaling.yaml`
- CloudFormation template
- Auto-scaling policies
- CloudWatch alarms
- Security groups

## Environment Variables

Stored in AWS Secrets Manager:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `SENDGRID_API_KEY`

Configured in task definition:
- `AWS_REGION`
- `SQS_URL`
- `S3_BUCKET`
- `SENDGRID_USER_EMAIL`

## Monitoring & Alarms

### CloudWatch Alarms:
- **High Queue Depth**: Triggers when >100 messages
- **Failed Tasks**: Triggers when >5 tasks fail in 5 minutes

### Metrics to Watch:
- `ECS Service CPU Utilization`
- `SQS ApproximateNumberOfMessagesVisible`
- `ECS Running Task Count`

## Manual Scaling

Force scale to specific count:
```bash
aws ecs update-service \
  --cluster crewcam-cluster \
  --service crewcam-sqs-worker-service \
  --desired-count 5
```

## Troubleshooting

### Check Logs
```bash
aws logs tail /ecs/crewcam-sqs-worker --follow
```

### Check Task Status
```bash
aws ecs describe-tasks \
  --cluster crewcam-cluster \
  --tasks $(aws ecs list-tasks --cluster crewcam-cluster --query 'taskArns[0]' --output text)
```

### Force New Deployment
```bash
aws ecs update-service \
  --cluster crewcam-cluster \
  --service crewcam-sqs-worker-service \
  --force-new-deployment
```

## Cost Optimization

- **Scale to Zero**: $0 when no jobs processing
- Uses Fargate Spot for cost savings (when available)
- Pay only for actual processing time
- Example costs:
  - Idle system: $0/month
  - 100 jobs/day @ 5min each: ~$2-5/month
  - Continuous processing: $30-300/month (1-10 tasks)

## Security

- Non-root container user
- Secrets in AWS Secrets Manager
- Task role with minimal permissions
- Private subnets recommended (update CloudFormation)

## Performance

With auto-scaling enabled:
- **Sequential (1 worker)**: ~10 jobs/hour
- **Parallel (10 workers)**: ~100 jobs/hour
- **Scale response time**: ~60 seconds

## Next Steps

1. Add DLQ (Dead Letter Queue) for failed messages
2. Implement graceful shutdown handling
3. Add custom metrics for job processing time
4. Configure VPC endpoints for AWS services
5. Set up SNS notifications for alarms