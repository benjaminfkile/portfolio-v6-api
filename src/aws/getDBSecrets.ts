import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { IDBSecrets } from "../interfaces";

// Ported in shape from file-manager-api/src/aws/getDBSecrets.ts. Reached ONLY
// when IS_LOCAL is unset (see src/config/loadConfig.ts).
export async function getDBSecrets(): Promise<IDBSecrets> {
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION,
  });

  const command = new GetSecretValueCommand({
    SecretId: process.env.AWS_DB_SECRET_ARN,
  });

  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error("SecretString is empty in Secrets Manager response");
  }

  return JSON.parse(response.SecretString) as IDBSecrets;
}
