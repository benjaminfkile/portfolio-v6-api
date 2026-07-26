import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { IAppSecrets } from "../interfaces";

// Ported in shape from file-manager-api/src/aws/getAppSecrets.ts. Reached ONLY
// when IS_LOCAL is unset (see src/config/loadConfig.ts); never invoked locally,
// so no AWS call is made when running with IS_LOCAL=true.
export async function getAppSecrets(): Promise<IAppSecrets> {
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION,
  });

  const command = new GetSecretValueCommand({
    SecretId: process.env.AWS_SECRET_ARN,
  });

  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error("SecretString is empty in Secrets Manager response");
  }

  return JSON.parse(response.SecretString) as IAppSecrets;
}
