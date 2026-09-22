export type httpClientConfig = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
  url: string;
  headers?: object;
  data?: object;
  auth?: {
    username: string;
    password: string;
  };
  params?: object;
  body?: object;
};
