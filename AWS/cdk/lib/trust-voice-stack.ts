import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3_notifications from 'aws-cdk-lib/aws-s3-notifications';
import * as config from 'aws-cdk-lib/aws-config';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { CLIENTS } from './config/clients';

export class TrustVoiceStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly chunksTable: dynamodb.Table;
  public readonly videosTable: dynamodb.Table;
  public readonly ingestLambdaRole: iam.Role;
  public readonly processLambdaRole: iam.Role;
  public readonly queryLambdaRole: iam.Role;
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── S3 BUCKETS ────────────────────────────────────────────────────────────
    //
    // Two buckets per client: one for raw video uploads, one for Transcribe
    // output JSON. Separate buckets mean separate IAM policies — IngestLambda
    // can read videos but never write to them; ProcessTranscriptLambda can read
    // transcripts but has no access to video buckets at all.
    //
    // removalPolicy: RETAIN means a `cdk destroy` will NOT delete these buckets.
    // Client estate data must never be accidentally destroyed by a CLI command.

    const videoBuckets: s3.Bucket[] = [];
    const transcriptBuckets: s3.Bucket[] = [];

    for (const client of CLIENTS) {
      const videos = new s3.Bucket(this, `VideosBucket-${client.id}`, {
        bucketName: `ttv-${client.id}-videos`,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        versioned: true,
        enforceSSL: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      const transcripts = new s3.Bucket(this, `TranscriptsBucket-${client.id}`, {
        bucketName: `ttv-${client.id}-transcripts`,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        versioned: true,
        enforceSSL: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      videoBuckets.push(videos);
      transcriptBuckets.push(transcripts);

      new cdk.CfnOutput(this, `VideosBucketName-${client.id}`, {
        value: videos.bucketName,
        description: `Video uploads bucket for ${client.name}`,
      });
    }

    // ── DYNAMODB TABLES ───────────────────────────────────────────────────────

    this.videosTable = new dynamodb.Table(this, 'VideosTable', {
      tableName: 'ttv-videos',
      partitionKey: { name: 'client_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'video_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.chunksTable = new dynamodb.Table(this, 'ChunksTable', {
      tableName: 'ttv-chunks',
      partitionKey: { name: 'client_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const queryLogTable = new dynamodb.Table(this, 'QueryLogTable', {
      tableName: 'ttv-query-log',
      partitionKey: { name: 'client_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'VideosTableName', { value: this.videosTable.tableName });
    new cdk.CfnOutput(this, 'ChunksTableName', { value: this.chunksTable.tableName });

    // ── COGNITO USER POOL ─────────────────────────────────────────────────────
    //
    // selfSignUpEnabled: false — trustees are created by admin only.
    // MFA REQUIRED — every trustee must enroll an authenticator app.
    // One Cognito Group per client (group name = client_id).
    // The signed JWT embeds group memberships under cognito:groups.
    // Lambda reads this claim server-side — the frontend never determines access.

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'ttv-trustees',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    for (const client of CLIENTS) {
      new cognito.CfnUserPoolGroup(this, `Group-${client.id}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: client.id,
        description: client.name,
      });
    }

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'ttv-web-client',
      authFlows: {
        userSrp: true,
      },
      generateSecret: false,
      accessTokenValidity: cdk.Duration.minutes(30),
      idTokenValidity: cdk.Duration.minutes(30),
      refreshTokenValidity: cdk.Duration.days(1),
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });

    // ── IAM ROLES ─────────────────────────────────────────────────────────────

    // MeLambda: reads env vars, returns client list. No AWS service calls needed.
    const meLambdaRole = new iam.Role(this, 'MeLambdaRole', {
      roleName: 'ttv-me-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // IngestLambda: triggered by S3 video upload, starts Transcribe job.
    this.ingestLambdaRole = new iam.Role(this, 'IngestLambdaRole', {
      roleName: 'ttv-ingest-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    for (const bucket of videoBuckets) bucket.grantRead(this.ingestLambdaRole);
    for (const bucket of transcriptBuckets) bucket.grantWrite(this.ingestLambdaRole);

    const mediaConvertRole = new iam.Role(this, 'MediaConvertRole', {
      roleName: 'ttv-mediaconvert-role',
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
    });
    for (const bucket of videoBuckets) bucket.grantRead(mediaConvertRole);
    for (const bucket of transcriptBuckets) bucket.grantWrite(mediaConvertRole);

    this.ingestLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
        'mediaconvert:CreateJob',
        'mediaconvert:GetJob',
        'mediaconvert:DescribeEndpoints',
      ],
      resources: ['*'],
    }));
    this.ingestLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [mediaConvertRole.roleArn],
    }));
    this.videosTable.grantWriteData(this.ingestLambdaRole);

    // ProcessTranscriptLambda: chunks transcript, embeds, upserts to Pinecone.
    this.processLambdaRole = new iam.Role(this, 'ProcessLambdaRole', {
      roleName: 'ttv-process-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    for (const bucket of transcriptBuckets) bucket.grantRead(this.processLambdaRole);
    this.chunksTable.grantWriteData(this.processLambdaRole);
    this.videosTable.grantWriteData(this.processLambdaRole);
    this.processLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
    }));
    this.processLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/pinecone-api-key*`,
      ],
    }));

    // VideoUrlLambda: generates a short-lived presigned S3 URL for video playback.
    // GetObject on video buckets is needed to sign the URL; it does NOT give the
    // role read access to the actual object bytes — that comes from the presigned URL.
    const videoUrlLambdaRole = new iam.Role(this, 'VideoUrlLambdaRole', {
      roleName: 'ttv-video-url-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    for (const bucket of videoBuckets) bucket.grantRead(videoUrlLambdaRole);
    this.videosTable.grantReadData(videoUrlLambdaRole);

    // QueryLambda: answers trustee questions. Lambda written in Phase 3.
    this.queryLambdaRole = new iam.Role(this, 'QueryLambdaRole', {
      roleName: 'ttv-query-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    this.chunksTable.grantReadData(this.queryLambdaRole);
    this.videosTable.grantReadData(this.queryLambdaRole);
    queryLogTable.grantWriteData(this.queryLambdaRole);
    this.queryLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
    }));
    this.queryLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/anthropic-api-key*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/pinecone-api-key*`,
      ],
    }));

    // ── CLOUDWATCH LOG GROUPS ─────────────────────────────────────────────────

    const videoUrlLogs = new logs.LogGroup(this, 'VideoUrlLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-video-url',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const meLogs = new logs.LogGroup(this, 'MeLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-me',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ingestLogs = new logs.LogGroup(this, 'IngestLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-ingest',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const processLogs = new logs.LogGroup(this, 'ProcessLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-process-transcript',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const queryLogs = new logs.LogGroup(this, 'QueryLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-query',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── VIDEO URL LAMBDA ──────────────────────────────────────────────────────
    //
    // GET /clients/{clientId}/videos/{videoId}/url
    // Generates a 1-hour presigned S3 URL for the raw video file so the frontend
    // can open it directly in the browser at the citation timestamp.

    const videoUrlFunction = new lambda_nodejs.NodejsFunction(this, 'VideoUrlFunction', {
      functionName: 'ttv-video-url',
      entry: path.join(__dirname, '..', 'lambdas', 'video-url', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: videoUrlLambdaRole,
      logGroup: videoUrlLogs,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        VIDEOS_TABLE: this.videosTable.tableName,
      },
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });

    // ── ME LAMBDA ─────────────────────────────────────────────────────────────
    //
    // NodejsFunction uses esbuild to bundle the TypeScript source at deploy time.
    // It follows imports, so withClientIsolation.ts and response.ts are bundled
    // automatically — no separate compile step needed.
    //
    // CLIENTS_JSON is injected as an env var so the Lambda never imports CDK code.
    // The client list is loaded once at cold start and cached in module scope.

    const meFunction = new lambda_nodejs.NodejsFunction(this, 'MeFunction', {
      functionName: 'ttv-me',
      entry: path.join(__dirname, '..', 'lambdas', 'me', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: meLambdaRole,
      logGroup: meLogs,
      timeout: cdk.Duration.seconds(10),
      environment: {
        CLIENTS_JSON: JSON.stringify(CLIENTS.map(c => ({ id: c.id, name: c.name }))),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // ── QUERY LAMBDA ─────────────────────────────────────────────────────────
    //
    // Handles POST /clients/{clientId}/query.
    //
    // PINECONE_INDEX_HOST: full host URL from the Pinecone console, e.g.:
    //   https://ttv-embeddings-abc123.svc.pinecone.io
    // Providing the host avoids a describe_index API round-trip on cold start.
    //
    // PINECONE_INDEX_NAME and PINECONE_INDEX_HOST must be updated here after
    // the Pinecone index is created. The secrets (API keys) are stored in
    // Secrets Manager and never appear in environment variables.

    const queryFunction = new lambda_nodejs.NodejsFunction(this, 'QueryFunction', {
      functionName: 'ttv-query',
      entry: path.join(__dirname, '..', 'lambdas', 'query', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: this.queryLambdaRole,
      logGroup: queryLogs,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ANTHROPIC_SECRET_ARN: `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/anthropic-api-key`,
        PINECONE_SECRET_ARN: `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/pinecone-api-key`,
        PINECONE_INDEX_NAME: 'ttv-embeddings',
        PINECONE_INDEX_HOST: 'https://ttv-embeddings-he5dsra.svc.aped-4627-b74a.pinecone.io',
        QUERY_LOG_TABLE: queryLogTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        // @aws-sdk/* packages are provided by the Lambda runtime and excluded by default.
        // @pinecone-database/pinecone and @anthropic-ai/sdk are bundled by esbuild.
      },
    });

    // ── INGEST LAMBDA ─────────────────────────────────────────────────────────
    //
    // Triggered by S3 ObjectCreated events on every video bucket.
    // Expects the S3 key to have the form: {videoId}/{filename}
    // where videoId is a UUID pre-generated by the frontend before upload.

    const ingestFunction = new lambda_nodejs.NodejsFunction(this, 'IngestFunction', {
      functionName: 'ttv-ingest',
      entry: path.join(__dirname, '..', 'lambdas', 'ingest', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: this.ingestLambdaRole,
      logGroup: ingestLogs,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        VIDEOS_TABLE: this.videosTable.tableName,
      },
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });

    // Wire S3 video upload → IngestLambda for each client bucket
    for (const bucket of videoBuckets) {
      bucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3_notifications.LambdaDestination(ingestFunction),
      );
    }

    // ── PROCESS TRANSCRIPT LAMBDA ─────────────────────────────────────────────
    //
    // Triggered by S3 ObjectCreated events on every transcript bucket.
    // Transcribe writes {videoId}/ttv-{videoId}.json — videoId is parsed from
    // key.split('/')[0]. Chunks transcript, embeds with Cohere, upserts to Pinecone.

    const processTranscriptFunction = new lambda_nodejs.NodejsFunction(
      this,
      'ProcessTranscriptFunction',
      {
        functionName: 'ttv-process-transcript',
        entry: path.join(__dirname, '..', 'lambdas', 'process-transcript', 'index.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        role: this.processLambdaRole,
        logGroup: processLogs,
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        environment: {
          VIDEOS_TABLE: this.videosTable.tableName,
          CHUNKS_TABLE: this.chunksTable.tableName,
          PINECONE_SECRET_ARN: `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/pinecone-api-key`,
          PINECONE_INDEX_NAME: 'ttv-embeddings',
          PINECONE_INDEX_HOST: 'https://ttv-embeddings-he5dsra.svc.aped-4627-b74a.pinecone.io',
        },
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'node22',
          // @pinecone-database/pinecone is bundled; @aws-sdk/* uses the runtime.
        },
      },
    );

    // Wire Transcribe output → ProcessTranscriptLambda for each transcript bucket
    for (const bucket of transcriptBuckets) {
      bucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3_notifications.LambdaDestination(processTranscriptFunction),
        { suffix: '.json' },
      );
    }

    // ── API GATEWAY ───────────────────────────────────────────────────────────
    //
    // API Gateway requires a single account-level IAM role to be set before it
    // can write access logs to CloudWatch. This is a one-time account setting —
    // CfnAccount manages it as a CloudFormation resource. The RestApi depends on
    // it so CloudFormation never creates the API stage before the role is set.

    const apiGwCloudWatchRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
      roleName: 'ttv-apigateway-cloudwatch-role',
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ),
      ],
    });

    const apiGwAccount = new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGwCloudWatchRole.roleArn,
    });

    // Access logging enabled with JSON format so the CloudWatch metric filter
    // below can query $.status = 403. Without structured JSON logs, you can only
    // monitor the aggregate 4XX metric, not 403 specifically.
    //
    // CORS is locked to the custom domain. Any preflight from a different origin
    // is rejected at the API Gateway layer before reaching Lambda.

    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/ttv/api-gateway/access',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'TrustVoiceApi', {
      // Must not create the deployment stage before the CloudWatch role is set
      restApiName: 'ttv-api',
      description: 'The Trust Voice trustee query API',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogs),
        // JSON structured format — required for $.status metric filter below
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: ['https://portal.thetrustvoice.com'],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Ensure the CloudWatch role is registered before the API stage is created
    this.api.node.addDependency(apiGwAccount);

    // ── COGNITO AUTHORIZER ────────────────────────────────────────────────────
    //
    // API Gateway validates the Cognito JWT signature before invoking any Lambda.
    // A request with a missing, expired, or forged token is rejected at the API
    // Gateway layer — the Lambda is never invoked at all.
    //
    // The validated claims (including cognito:groups) are passed to Lambda via
    // event.requestContext.authorizer.claims. withClientIsolation reads from there.

    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'CognitoAuthorizer',
      {
        cognitoUserPools: [this.userPool],
        authorizerName: 'ttv-cognito-authorizer',
        identitySource: 'method.request.header.Authorization',
      },
    );

    const authOptions: apigateway.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    // ── ROUTES ────────────────────────────────────────────────────────────────
    //
    // GET /me — returns the list of clients this trustee is authorized to query.
    // POST /clients/{clientId}/query — runs the RAG pipeline for a trustee question.
    //
    // The {clientId} path parameter is validated server-side inside QueryLambda
    // via withClientIsolation — it must match a group in the trustee's JWT.

    const meResource = this.api.root.addResource('me');
    meResource.addMethod('GET', new apigateway.LambdaIntegration(meFunction), authOptions);

    const clientsResource = this.api.root.addResource('clients');
    const clientIdResource = clientsResource.addResource('{clientId}');
    const queryResource = clientIdResource.addResource('query');
    queryResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(queryFunction),
      authOptions,
    );

    const videosResource = clientIdResource.addResource('videos');
    const videoIdResource = videosResource.addResource('{videoId}');
    const videoUrlResource = videoIdResource.addResource('url');
    videoUrlResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(videoUrlFunction),
      authOptions,
    );

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway base URL',
    });

    // ── PORTAL FRONTEND (CloudFront + S3) ─────────────────────────────────────
    //
    // Private S3 bucket holds the React build output. CloudFront is the only
    // allowed reader via Origin Access Control (OAC) — the bucket has no public
    // access policy and no website endpoint enabled.
    //
    // SPA routing: S3 returns 403 for any key that doesn't exist (because the
    // bucket is private, not 404). We map both 403 and 404 → /index.html with
    // a 200 so the React Router handles the path client-side.
    //
    // To deploy the frontend after a build:
    //   aws s3 sync dist/ s3://<PortalBucketName> --delete
    //   aws cloudfront create-invalidation --distribution-id <id> --paths "/*"

    const portalBucket = new s3.Bucket(this, 'PortalBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ACM certificate issued for portal.thetrustvoice.com on 2026-05-22.
    // CloudFront requires certs in us-east-1 regardless of stack region.
    const portalCert = acm.Certificate.fromCertificateArn(
      this,
      'PortalCertificate',
      'arn:aws:acm:us-east-1:595028889888:certificate/f97ae843-00e8-4295-91e7-072f106abedb',
    );

    const portalDistribution = new cloudfront.Distribution(this, 'PortalDistribution', {
      defaultBehavior: {
        origin: cloudfront_origins.S3BucketOrigin.withOriginAccessControl(portalBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },
      domainNames: ['portal.thetrustvoice.com'],
      certificate: portalCert,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: false,
    });

    new cdk.CfnOutput(this, 'PortalDistributionDomain', {
      value: portalDistribution.distributionDomainName,
      description: 'Add as CNAME for portal.thetrustvoice.com in GoDaddy',
    });

    new cdk.CfnOutput(this, 'PortalDistributionId', {
      value: portalDistribution.distributionId,
      description: 'CloudFront distribution ID — needed for cache invalidation after deploys',
    });

    new cdk.CfnOutput(this, 'PortalBucketName', {
      value: portalBucket.bucketName,
      description: 'Deploy React build: aws s3 sync dist/ s3://<bucket> --delete',
    });

    // ── CLOUDWATCH 403 ALARM ──────────────────────────────────────────────────
    //
    // Active from the moment the first trustee logs in (Phase 2 requirement).
    //
    // How it works:
    //   1. API Gateway writes structured JSON access logs to apiAccessLogs group
    //   2. MetricFilter counts every log entry where $.status = 403
    //   3. Alarm fires when ≥5 403s occur in a single 5-minute window
    //   4. SNS topic delivers the alert — subscribe your email below
    //
    // Why 5 in 5 minutes: in normal operation a trustee never hits a 403 (they
    // only see their authorized clients). A spike means something is probing the
    // isolation boundary — either a bug or a deliberate access attempt.

    const forbidden403Filter = new logs.MetricFilter(this, 'Forbidden403Filter', {
      logGroup: apiAccessLogs,
      filterPattern: logs.FilterPattern.stringValue('$.status', '=', '403'),
      metricNamespace: 'TrustVoice/API',
      metricName: 'ForbiddenRequests',
      metricValue: '1',
      defaultValue: 0,
    });

    const securityAlertTopic = new sns.Topic(this, 'SecurityAlertTopic', {
      topicName: 'ttv-security-alerts',
      displayName: 'The Trust Voice — Security Alerts',
    });

    const alarm = new cloudwatch.Alarm(this, 'Forbidden403Alarm', {
      alarmName: 'ttv-403-spike',
      alarmDescription:
        '≥5 HTTP 403 responses in 5 minutes — possible cross-client access probe. ' +
        'Check /ttv/api-gateway/access logs immediately.',
      metric: forbidden403Filter.metric({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(securityAlertTopic));

    new cdk.CfnOutput(this, 'SecurityAlertTopicArn', {
      value: securityAlertTopic.topicArn,
      description: 'Subscribe your email to this SNS topic to receive 403 spike alerts',
    });

    // ── AWS CONFIG — S3 SECURITY RULES ───────────────────────────────────────
    //
    // The recorder and delivery channel have a CloudFormation circular dependency:
    // the recorder needs a delivery channel to start, and the delivery channel
    // needs the recorder to exist. CloudFormation cannot resolve this ordering.
    //
    // Resolution: activate Config via CLI once before the first deploy (see below),
    // then CDK manages only the role, bucket, and rules.
    //
    // One-time CLI setup (run once per account, never again):
    //
    //   # 1. Create the IAM role
    //   aws iam create-role --role-name ttv-config-role \
    //     --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"config.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
    //   aws iam attach-role-policy --role-name ttv-config-role \
    //     --policy-arn arn:aws:iam::aws:policy/service-role/AWS_ConfigRole
    //
    //   # 2. Create the delivery S3 bucket
    //   aws s3api create-bucket --bucket ttv-config-{ACCOUNT_ID} --region us-east-1
    //
    //   # 3. Wire recorder + delivery channel (no CloudFormation circular dep here)
    //   aws configservice put-configuration-recorder \
    //     --configuration-recorder name=ttv-config-recorder,roleARN=arn:aws:iam::{ACCOUNT_ID}:role/ttv-config-role,recordingGroup='{allSupported:true,includeGlobalResourceTypes:true}'
    //   aws configservice put-delivery-channel \
    //     --delivery-channel name=ttv-config-delivery,s3BucketName=ttv-config-{ACCOUNT_ID}
    //   aws configservice start-configuration-recorder \
    //     --configuration-recorder-name ttv-config-recorder
    //
    // After that one-time setup, CDK deploys the managed rules below normally.

    // Six S3 security rules — evaluated against every bucket in the account.
    // These require an active Config recorder (set up via one-time CLI steps above).
    new config.ManagedRule(this, 'S3PublicReadProhibited', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_READ_PROHIBITED,
      description: 'S3 buckets must not allow public read access.',
    });

    new config.ManagedRule(this, 'S3PublicWriteProhibited', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_WRITE_PROHIBITED,
      description: 'S3 buckets must not allow public write access.',
    });

    new config.ManagedRule(this, 'S3SslRequestsOnly', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_SSL_REQUESTS_ONLY,
      description: 'S3 bucket policies must deny HTTP (non-TLS) requests.',
    });

    new config.ManagedRule(this, 'S3ServerSideEncryption', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED,
      description: 'S3 buckets must have default server-side encryption enabled.',
    });

    new config.ManagedRule(this, 'S3VersioningEnabled', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_VERSIONING_ENABLED,
      description: 'S3 buckets must have versioning enabled.',
    });

    new config.ManagedRule(this, 'S3BlockPublicAccess', {
      identifier: config.ManagedRuleIdentifiers.S3_ACCOUNT_LEVEL_PUBLIC_ACCESS_BLOCKS_PERIODIC,
      description: 'Account-level S3 Block Public Access settings must be enabled.',
    });
  }
}
