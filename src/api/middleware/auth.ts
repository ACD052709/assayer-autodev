/** Authentication must be added before deployment. */
export async function authMiddleware(
  request: Request,
  next: () => Promise<Response>,
): Promise<Response> {
  void request;
  return next();
}
