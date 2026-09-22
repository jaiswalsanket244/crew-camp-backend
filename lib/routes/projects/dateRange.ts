import * as dayjs from "dayjs";
import * as utc from "dayjs/plugin/utc";

dayjs.extend(utc);

export const getProjectListDayStart = (date: string | Date): Date => {
  return dayjs.utc(date).startOf("day").toDate();
};

export const getProjectListDayEnd = (date: string | Date): Date => {
  return dayjs.utc(date).endOf("day").toDate();
};

export const parseProjectListDateRange = (rawDateRange: string) => {
  const parsedDateRange = JSON.parse(rawDateRange);

  if (!parsedDateRange?.startDate) {
    throw new Error("dateRange.startDate is required");
  }

  return {
    startDate: getProjectListDayStart(parsedDateRange.startDate),
    endDate: getProjectListDayEnd(
      parsedDateRange.endDate || parsedDateRange.startDate,
    ),
  };
};
