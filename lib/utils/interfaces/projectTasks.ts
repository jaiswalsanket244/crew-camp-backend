import { Types } from "mongoose";
import { MY_TASKS_FILTER } from "../enums/tasks";

export interface IProjectTasksFindAll {
  projectId: string;
  taskId?: string;
  search: string;
  limit?: number;
}

export interface IMyTasksQuery {
  userId: Types.ObjectId;
  projectIds: Types.ObjectId[];
  filter: MY_TASKS_FILTER;
  status?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export interface IMyTaskRow {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  status: string;
  severity: string;
  createdAt: Date;
  userId: Types.ObjectId;
  userName: string;
  projectId: Types.ObjectId;
  projectName: string;
  taskImage?: string;
  isProjectArchived: boolean;
  assignedTo?: { userId: Types.ObjectId; userName: string }[];
}

export interface IPagination {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface IMyTasksResult {
  data: IMyTaskRow[];
  pagination: IPagination;
}
