import mongoose from "mongoose";
import * as crypto from "crypto";
import { config } from "../configuration/config";
import { User } from "../../db";
import * as jwt from "jsonwebtoken";
import { PROJECT_ACCESS } from "../enums/enums";
import { CompaniesType, ObjectIdType } from "../interfaces/schemaInterface";
import shortUrl = require("node-url-shortener");
import * as dayjs from "dayjs";
import * as utc from "dayjs/plugin/utc";
import * as timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

const JWT_SECRET: string = config.JWT_SECRET || "i am a tea pot";

const ObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

const isValidObjectId = (value: string): boolean => {
  return mongoose.Types.ObjectId.isValid(value);
};

const getFirebaseUserConfig = () => {
  return {
    apiKey: config.FIREBASE_API_KEY,
    authDomain: config.FIREBASE_AUTH_DOMAIN,
    projectId: config.FIREBASE_PROJECT_ID,
    storageBucket: config.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: config.FIREBASE_MESSAGING_SENDER_ID,
    appId: config.FIREBASE_APP_ID,
  };
};

const getJWTToken = (payload: object, expiresIn: number = 86400) =>
  jwt.sign({ data: payload }, JWT_SECRET, {
    expiresIn: `${expiresIn}h`,
  });

const generateTokenForAuth = (email: string) => {
  const token = jwt.sign(
    { exp: Math.floor(Date.now() / 1000) + 60 * 60, email_id: email },
    JWT_SECRET,
  );
  return token;
};

const generateReferralCode = async () => {
  let referralCode: string;
  let isUnique: boolean = false;

  while (!isUnique) {
    referralCode = `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 4)}`;

    const existingCodes = await User.find({ referralCode }).lean();

    if (existingCodes.length === 0) {
      isUnique = true;
    }
  }

  return referralCode;
};

function createFacetPipeline(page: number, skips: number, pageSize: number) {
  return [
    {
      $facet: {
        items: [{ $skip: skips }, { $limit: pageSize }],
        count: [{ $count: "count" }],
      },
    },
    {
      $addFields: {
        total: { $ifNull: [{ $arrayElemAt: ["$count.count", 0] }, 0] },
        page: page,
        pageSize: pageSize,
      },
    },
    {
      $project: {
        items: 1,
        total: 1,
        page: 1,
        pageSize: 1,
        totalPages: {
          $ceil: {
            $divide: ["$total", "$pageSize"],
          },
        },
      },
    },
  ];
}

function getUserNamePipeline(key?: string) {
  return [
    {
      $lookup: {
        from: "users",
        localField: key || "userId",
        foreignField: "_id",
        as: "userInfo",
      },
    },
    {
      $lookup: {
        from: "companymembers",
        localField: key || "userId",
        foreignField: "userId",
        as: "usercompanyInfo",
      },
    },
    {
      $addFields: {
        userName: {
          $concat: [
            { $arrayElemAt: ["$userInfo.name.first", 0] },
            " ",
            { $arrayElemAt: ["$userInfo.name.last", 0] },
          ],
        },
        profileImage: {
          $arrayElemAt: ["$userInfo.profileImage", 0],
        },
        userContactInfo: {
          email: {
            $arrayElemAt: ["$userInfo.email", 0],
          },
          phone: {
            $arrayElemAt: ["$userInfo.phone", 0],
          },
        },
        userRole: {
          $arrayElemAt: ["$userInfo.userRole", 0],
        },
        roles: {
          $arrayElemAt: ["$usercompanyInfo.role", 0],
        },
        lastActivity: {
          $arrayElemAt: ["$userInfo.lastActivity", 0],
        },
      },
    },
  ];
}

function getProjectNamePipeline(key?: string) {
  return [
    {
      $lookup: {
        from: "projects",
        localField: key || "projectId",
        foreignField: "_id",
        as: "projectInfo",
      },
    },
    {
      $addFields: {
        projectName: {
          $arrayElemAt: ["$projectInfo.name", 0],
        },
        archivedAt: {
          $arrayElemAt: ["$projectInfo.archivedAt", 0],
        },
      },
    },
  ];
}

function verifyToken(token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        reject(err);
      } else {
        resolve(decoded);
      }
    });
  });
}

const month = [
  "Jan",
  "Feb",
  "March",
  "Apr",
  "May",
  "Jun",
  "July",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function timeAgo(targetTime, currentTime) {
  const { diffInDays, diffInHours, diffInMinutes } = getTimeDiffs(
    targetTime,
    currentTime,
  );

  if (diffInDays) {
    if (diffInDays == 1) return `1d`;
    return `${diffInDays}d`;
  }
  if (diffInHours) {
    if (diffInHours == 1) return `1h`;
    return `${diffInHours}h`;
  }
  if (diffInMinutes) {
    if (diffInMinutes == 1) return `1m`;
    return `${diffInMinutes}m`;
  }
  return "now";
}

const convertTime = (time, onlyDate?: boolean) => {
  const timeStamp = new Date(time);
  const currStamp = new Date();
  const date =
    month[timeStamp.getMonth()] +
    " " +
    timeStamp.getDate() +
    ", " +
    timeStamp.getFullYear();

  if (
    timeStamp.getMonth() == currStamp.getMonth() &&
    timeStamp.getFullYear() == currStamp.getFullYear() &&
    !onlyDate
  ) {
    return timeAgo(timeStamp, currStamp);
  }
  return date;
};

const getTimeDiffs = (time, currentTime) => {
  const start = dayjs(time);
  const end = dayjs(currentTime);

  const diffInYears = end.diff(start, "year");
  start.add(diffInYears, "year"); // Subtract the years from end date
  const diffInMonths = end.diff(start, "month");
  start.add(diffInMonths, "month"); // Subtract the months from end date
  const diffInDays = end.diff(start, "day");
  start.add(diffInDays, "day"); // Subtract the days from end date
  const diffInHours = end.diff(start, "hour");
  start.add(diffInHours, "hour"); // Subtract the hours from end time
  const diffInMinutes = end.diff(start, "minute");

  return {
    diffInYears,
    diffInMonths,
    diffInDays,
    diffInHours,
    diffInMinutes,
  };
};

const getDaysDiff = (time, currentTime) => {
  const { diffInYears, diffInMonths, diffInDays, diffInHours, diffInMinutes } =
    getTimeDiffs(time, currentTime);

  if (diffInYears) return diffInYears + "Y";
  if (diffInMonths) return diffInMonths + "M";
  if (diffInDays) return diffInDays + "D";
  if (diffInHours) return diffInHours + "h";
  if (diffInMinutes) return diffInMinutes + "m";
  return "now";
};

const getActiveAdminCompanies = (
  companies: CompaniesType[] = [],
): ObjectIdType[] => {
  const arr: ObjectIdType[] = [];
  for (const c of companies) {
    if (PROJECT_ACCESS.includes(c.role)) arr.push(c.companyId);
  }
  return arr;
};

const generateRandomHex = (): string => {
  const hexChars: string = "0123456789ABCDEF";
  let hexCode: string = "#";
  for (let i = 0; i < 6; i++) {
    hexCode += hexChars.charAt(Math.floor(Math.random() * hexChars.length));
  }
  return hexCode;
};

const getLastWeekStartAndEnd = (date) => {
  const currentDate = dayjs(date);
  const lastWeekStart = currentDate
    .subtract(1, "week")
    .startOf("week")
    .startOf("day");
  const lastWeekEnd = currentDate
    .subtract(1, "week")
    .endOf("week")
    .endOf("day");
  return {
    start: lastWeekStart.format("YYYY-MM-DD HH:mm:ss"),
    end: lastWeekEnd.format("YYYY-MM-DD HH:mm:ss"),
  };
};

const getTimeStamp = (date) => {
  return dayjs(date).format("MM-DD-YYYY HH:mm:ss");
};

const getDate = (date) => {
  return dayjs(date).format("MM/DD/YYYY");
};

const getTimeFormatForS3 = () => {
  return dayjs().format("MM-DD-YYYY__HH-mm-ss");
};

function getLastMonthStartAndEnd(date) {
  const currentDate = dayjs(date);
  const lastMonthStart = currentDate
    .subtract(1, "month")
    .startOf("month")
    .startOf("day");
  const lastMonthEnd = currentDate
    .subtract(1, "month")
    .endOf("month")
    .endOf("day");
  return {
    startDate: new Date(lastMonthStart.format("YYYY-MM-DD HH:mm:ss")),
    endDate: new Date(lastMonthEnd.format("YYYY-MM-DD HH:mm:ss")),
  };
}

const getDayStart = (date) => {
  const current = dayjs(date).startOf("day");
  return new Date(current.format("YYYY-MM-DD HH:mm:ss"));
};

const getDayEnd = (date) => {
  const current = dayjs(date).endOf("day");
  return new Date(current.format("YYYY-MM-DD HH:mm:ss"));
};

const getMonthAndYear = (date) => {
  const current = dayjs(date);
  return {
    year: current.year(),
    month: current.month() + 1,
  };
};

const removeHours = (date, hrs) => {
  const current = dayjs(date).subtract(hrs, "hour").format();
  return new Date(current);
};

const removeDays = (date, days) => {
  const current = dayjs(date).subtract(days, "day").format();
  return new Date(current);
};

const getDateWithTimeZone = (date: string, targetTimezone?: string) => {
  if (targetTimezone) {
    return dayjs(date).tz(targetTimezone).format("MM/DD/YYYY");
  }
  return dayjs(date).format("MM/DD/YYYY");
};

const capitalize = (plan: string) => {
  const string = plan.toLowerCase().split("");
  string[0] = string[0].toUpperCase();
  return string.join("");
};

const getShortenedUrl = async (longUrl) => {
  return new Promise((resolve) => {
    shortUrl.short(longUrl, function (err, url) {
      if (err) {
        console.log({ err });
        resolve(longUrl);
      } else {
        resolve(url);
      }
    });
  });
};

/**
 * Builds the S3 object key for an upload.
 *
 * Keys are scoped per company and carry a random component. The previous flat
 * `<timestamp>--<name>` layout put every tenant in one namespace with a fully
 * predictable key, which meant objects could be enumerated across companies
 * (camera filenames are highly guessable and a day is only 86,400 timestamps)
 * and two uploads of the same filename in the same second silently overwrote
 * each other — across tenants.
 *
 * Callers with no company fall back to the legacy layout so unauthenticated
 * upload paths keep working; existing objects are unaffected, since every
 * consumer reads the stored url rather than recomputing the key.
 */
const buildS3ObjectKey = (fileName: string, companyId?: string): string => {
  // sanitizeFileName appends the extension verbatim, so a crafted name
  // ("a.jpg/../x") can still carry "/" through it. That was harmless while keys
  // were flat, but the company prefix below is a boundary — scrub separators
  // again rather than changing the shared helper, which the internal file
  // upload route also uses.
  const safeName = sanitizeFileName(String(fileName ?? ""))
    .replace(/[^a-zA-Z0-9_\-. ]/g, "")
    .replace(/\s+/g, "_");
  // ObjectId hex only — this value becomes a path segment.
  const scope = String(companyId ?? "").replace(/[^a-fA-F0-9]/g, "");

  if (!scope) {
    return `${getTimeFormatForS3()}--${safeName}`;
  }

  return `companies/${scope}/${crypto.randomUUID()}--${safeName}`;
};

function sanitizeFileName(fileName: string): string {
  const ext =
    fileName.lastIndexOf(".") > 0
      ? fileName.slice(fileName.lastIndexOf("."))
      : "";
  const name =
    fileName.lastIndexOf(".") > 0
      ? fileName.slice(0, fileName.lastIndexOf("."))
      : fileName;
  const sanitized = name.replace(/[^a-zA-Z0-9_\-. ]/g, "").replace(/\s+/g, "_");
  return sanitized + ext;
}

const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// Escape a user-supplied string so it is matched LITERALLY inside a Mongo
// { $regex } (substring search), not interpreted as a regex. Prevents regex
// metacharacters from corrupting results and pathological patterns from pinning
// CPU (ReDoS / expensive-query DoS). Length-capped by the caller.
const escapeRegExp = (input: string): string =>
  String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export {
  ObjectId,
  isValidObjectId,
  getFirebaseUserConfig,
  getJWTToken,
  generateReferralCode,
  generateTokenForAuth,
  createFacetPipeline,
  verifyToken,
  convertTime,
  getUserNamePipeline,
  getDaysDiff,
  getActiveAdminCompanies,
  generateRandomHex,
  getProjectNamePipeline,
  getLastWeekStartAndEnd,
  getLastMonthStartAndEnd,
  getDayStart,
  getDayEnd,
  getMonthAndYear,
  getTimeStamp,
  getTimeDiffs,
  removeHours,
  removeDays,
  timeAgo,
  getDate,
  getDateWithTimeZone,
  capitalize,
  getShortenedUrl,
  getTimeFormatForS3,
  delay,
  sanitizeFileName,
  buildS3ObjectKey,
  escapeRegExp,
};
