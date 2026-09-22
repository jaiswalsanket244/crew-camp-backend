import * as express from "express";
import * as status from "http-status";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { SuccessResponse } from "../../utils/helpers/apiResponse";
import { ChatHelpers } from "./helpers";
export class ChatRoutes {
  public static searchUser = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const email = req.query.email as string;
      const users = await ChatHelpers.searchUser(email);
      return SuccessResponse(res, status.OK, {
        message: "success.",
        data: users,
      });
    } catch (error) {
      next(error);
    }
  };

  public static addUserDataToQuery = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const usersList = req.body.users;
      const userId = req.user._id;

      const newList = await Promise.all(
        usersList.map(async (element) => {
          const chatUsers = Object.keys(element.users);
          const differentUserId = chatUsers.find(
            (id) => id !== userId.toString(),
          );

          if (differentUserId) {
            const differentUserInfo =
              await ChatHelpers.findUserInfo(differentUserId);
            element.differentUser = differentUserInfo[0];
          }

          return element;
        }),
      );

      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: newList,
      });
    } catch (error) {
      next(error);
    }
  };
}
