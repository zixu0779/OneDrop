export async function readGraphError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();

    if (typeof body !== "object" || body === null) {
      return response.statusText;
    }

    const error = (body as Record<string, unknown>).error;

    if (typeof error !== "object" || error === null) {
      return response.statusText;
    }

    const message = (error as Record<string, unknown>).message;
    return typeof message === "string" ? message : response.statusText;
  } catch {
    return response.statusText;
  }
}
