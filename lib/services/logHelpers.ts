import * as MaskData from "mask-json";

export const maskJsonData = (data) => {
  const maskingOptions: string[] = ["password", "token"];
  const masker = MaskData(maskingOptions);
  const maskedObj = masker(data);
  return maskedObj;
};
