import axios from "axios";
import { httpClientConfig } from "../utils/interfaces/httpClientConfig";

export class HttpClient {
  public static async Request(request: httpClientConfig) {
    try {
      const response = await axios(request);
      return response.data;
    } catch (err) {
      return err;
    }
  }
}
