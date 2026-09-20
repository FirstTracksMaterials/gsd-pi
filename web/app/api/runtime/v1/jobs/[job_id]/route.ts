import { buildJobSnapshot, control, controlError, dynamic, runtime } from "../../_shared.ts";

export { dynamic, runtime };

export async function GET(
  _request: Request,
  context: { params: Promise<{ job_id: string }> | { job_id: string } },
): Promise<Response> {
  try {
    const resolved = await Promise.resolve(context.params);
    const jobId = decodeURIComponent(resolved.job_id ?? "");
    const snapshot = await buildJobSnapshot(await control(), jobId);
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return controlError(error);
  }
}
