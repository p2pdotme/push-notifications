import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 forwards synchronous throws to the error middleware but not
 * rejected promises from async handlers. This wrapper bridges that gap so
 * async handlers can `throw`/`await` and still hit our centralised error
 * handler instead of producing an unhandled rejection.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
