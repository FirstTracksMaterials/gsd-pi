import { control, controlError, dynamic, runtime, subscribeProjectEvents } from "../../../_shared.ts";

export { dynamic, runtime };

const encoder = new TextEncoder();

export async function GET(
  request: Request,
  context: { params: Promise<{ project_id: string }> | { project_id: string } },
): Promise<Response> {
  try {
    const resolved = await Promise.resolve(context.params);
    const projectId = decodeURIComponent(resolved.project_id ?? "");
    const url = new URL(request.url);
    const after = url.searchParams.get("after");
    const runtimeControl = await control();
    let unsubscribe: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        unsubscribe = subscribeProjectEvents(runtimeControl, projectId, after, (frame) => {
          try {
            if (frame.kind === "comment") {
              controller.enqueue(encoder.encode(`: ${frame.comment}\n\n`));
              return;
            }
            controller.enqueue(encoder.encode(`id: ${frame.event.cursor}\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame.event)}\n\n`));
          } catch {
            unsubscribe?.();
          }
        });
        request.signal.addEventListener("abort", () => {
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            // already closed
          }
        }, { once: true });
      },
      cancel() {
        unsubscribe?.();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return controlError(error);
  }
}
