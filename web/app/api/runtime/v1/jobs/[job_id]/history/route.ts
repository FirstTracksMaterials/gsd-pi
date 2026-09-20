import { control, controlError, dynamic, readJobHistory, runtime } from "../../../_shared.ts";

export { dynamic, runtime };

export async function GET(
  request: Request,
  context: { params: Promise<{ job_id: string }> | { job_id: string } },
): Promise<Response> {
  try {
    const resolved = await Promise.resolve(context.params);
    const jobId = decodeURIComponent(resolved.job_id ?? "");
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const page = readJobHistory(await control(), jobId, { cursor, limit });
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return controlError(error);
  }
}
