resource "aws_s3_bucket" "logs" {
  bucket = "my-logs-bucket"
}

resource "aws_lambda_function" "processor" {
  function_name = "processor"
  environment {
    variables = {
      BUCKET = aws_s3_bucket.logs.bucket
    }
  }
}

resource "aws_iam_role" "lambda_role" {
  name = "lambda-role"
}
