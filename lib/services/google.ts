import { config } from "../utils/configuration/config";

export const getAddressFromCoordinates = async (lat: number, lng: number) => {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${config.GOOGLE_API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.status === "OK") {
    return data.plus_code.compound_code;
  }
  return "";
};
