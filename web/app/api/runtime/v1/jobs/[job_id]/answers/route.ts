import { notReady, dynamic, runtime } from "../../../_shared.ts";

export { dynamic, runtime };

export async function POST(): Promise<Response> {
  return notReady("Pending-input answers are not ready until C06");
}
