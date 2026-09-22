export enum MANAGE_TYPE {
  JOIN = "join",
  LEAVE = "leave",
}

// How a task qualifies as "mine" on GET /projectTasks/mine.
// Values are mirrored by the app's MyTasksFilter enum — keep them in sync.
export enum MY_TASKS_FILTER {
  ASSIGNED = "assigned",
  CREATED = "created",
  ALL = "all",
}
