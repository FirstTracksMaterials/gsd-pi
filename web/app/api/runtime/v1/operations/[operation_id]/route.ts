import { admitResponse, control, dynamic, getOperation, routeParam, runtime } from "../../_shared.ts";

export { dynamic, runtime };

export async function GET(
  _request: Request,
  context: { params: Promise<{ operation_id: string }> | { operation_id: string } },
): Promise<Response> {
  const operationId = await routeParam(context.params, "operation_id");
  return admitResponse(getOperation(control(), operationId));
}
