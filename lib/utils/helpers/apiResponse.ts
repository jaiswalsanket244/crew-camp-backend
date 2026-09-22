import { ApiResponseType } from "../../utils/interfaces/apiResponse";
import { Response } from "express";

export const ApiResponse = (params: ApiResponseType) => {
  return {
    success: params.success,
    message: params.message,
    data: params?.data || {},
    errors: params?.errors || {},
  };
};

export const SuccessResponse = (
  res: Response,
  statusCode: number,
  params: ApiResponseType,
) => {
  return res.status(statusCode).json({
    success: true,
    message: params.message,
    data: params?.data || {},
    totalCounts: params.totalCounts,
    nextCursor: params.nextCursor,
    errors: params?.errors || {},
  });
};

export const ErrorResponse = (
  res: Response,
  statusCode: number,
  params: ApiResponseType,
) => {
  return res.status(statusCode).json({
    success: false,
    message: params.message,
    data: params?.data || {},
    errors: params?.errors || {},
  });
};
