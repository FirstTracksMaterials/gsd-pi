import { notReady, dynamic, runtime } from "../../../_shared.ts";

export { dynamic, runtime };

export async function GET(): Promise<Response> {
  return notReady("Project event streams are not ready until C07");
}
