import { StreamChat } from "stream-chat";
import { config } from "../utils/configuration/config";

const getStreamClient = () => {
  return StreamChat.getInstance(
    config.GET_STREAM_MESSAGING_KEY,
    config.GET_STREAM_MESSAGING_SECRET,
    { allowServerSideConnect: true },
  );
};

const addUserToGetStreamClient = async ({
  id,
  name,
  email,
}: {
  id: string;
  name: string;
  email: string;
}) => {
  const getStreamInstance = getStreamClient();
  return getStreamInstance.upsertUser({
    id,
    name,
    role: "user",
    email,
  });
};

const getTokenFromGetstream = (id: string) => {
  const getStreamInstance = getStreamClient();
  const token = getStreamInstance.createToken(`${id}`);
  return token;
};

export { getStreamClient, addUserToGetStreamClient, getTokenFromGetstream };
