import * as express from "express";

export const blockExternalApiRequests = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const blockedHost = ["api.crewcamapp.com", "api.relaycam.com"]; // host to block
  const requestHost = req.headers.host;

  if (requestHost && blockedHost.includes(requestHost)) {
    return res.status(404).json({
      status: "error",
      message: "Not found",
    });
  }

  next();
};
