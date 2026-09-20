import { notReady, dynamic, runtime } from "../../../_shared.ts";

export { dynamic, runtime };

export async function GET(): Promise<Response> {
  return notReady("Job list snapshots are not ready until C07");
}

export async function POST(): Promise<Response> {
  return notReady("Job import is not ready until C06");
}
