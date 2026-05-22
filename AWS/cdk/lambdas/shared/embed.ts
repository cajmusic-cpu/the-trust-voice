import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({});
const MODEL_ID = 'amazon.titan-embed-text-v2:0';

interface TitanEmbedResponse {
  embedding: number[];
  inputTextTokenCount: number;
}

// Embeds an array of texts using Amazon Titan Embed Text v2 (1024 dims).
// Titan takes one text per call — texts are processed sequentially.
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];

  for (const text of texts) {
    const res = await bedrock.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text, dimensions: 1024, normalize: true }),
      }),
    );

    const decoded = JSON.parse(
      new TextDecoder().decode(res.body),
    ) as TitanEmbedResponse;

    if (!decoded.embedding?.length) throw new Error('Bedrock Titan returned no embedding');
    results.push(decoded.embedding);
  }

  return results;
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}
