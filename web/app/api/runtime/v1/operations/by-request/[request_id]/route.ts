import { admitResponse, control, dynamic, getOperationByRequest, routeParam, runtime } from "../../../_shared.ts";

export { dynamic, runtime };

export async function GET(
  _request: Request,
  context: { params: Promise<{ request_id: string }> | { request_id: string } },
): Promise<Response> {
  const requestId = await routeParam(context.params, "request_id");
  return admitResponse(getOperationByRequest(await control(), requestId));
}
