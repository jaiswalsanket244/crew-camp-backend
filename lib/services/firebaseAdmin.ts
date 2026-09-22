import * as admin from "firebase-admin";
import { initializeApp } from "firebase/app";
import { Auth, getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { getFirebaseUserConfig } from "../utils/helpers/commonHelper";
import * as path from "path";

type notificationBody = {
  notification: {
    title: string;
    body: string;
  };
  data?: Record<string, string>;
  tokens: string[];
};
class FirebaseAdminService {
  private auth: Auth;

  constructor() {
    // Firebase admin initialization
    admin.initializeApp({
      credential: admin.credential.cert(
        path.resolve(__dirname, "../../lib/firebase-cert.json"),
      ),
    });

    // Firebase User and auth initialization
    const firebaseApp = initializeApp(getFirebaseUserConfig());

    this.auth = getAuth(firebaseApp);
  }

  createUser = async (
    name: { first: string; last: string },
    email: string,
    phoneNumber?: string,
  ) => {
    try {
      const firebaseUser = {
        displayName: `${name.first} ${name.last}`,
        email,
        emailVerified: false,
        phoneNumber,
      };
      const firebaseAuthUser = await admin.auth().createUser(firebaseUser);
      return firebaseAuthUser;
    } catch (err) {
      this.catchError(err.message);
    }
  };

  updateUserPhone = (uid: string, phoneNumber: string) => {
    return admin.auth().updateUser(uid, { phoneNumber });
  };

  // Throws on failure (e.g. auth/email-already-exists) so callers can gate the
  // Mongo update on Firebase succeeding first, keeping the two in sync.
  updateUserEmail = (uid: string, email: string) => {
    return admin.auth().updateUser(uid, { email });
  };

  findUser = async (email) => {
    return admin.auth().getUserByEmail(email);
  };

  findUserByPhone = async (phone: string) => {
    return admin.auth().getUserByPhoneNumber(phone);
  };

  signInUser = async (email: string, password: string) => {
    try {
      const firebaseUser = await signInWithEmailAndPassword(
        this.auth,
        email,
        password,
      );
      return firebaseUser;
    } catch (err) {
      throw new Error(err.message);
    }
  };

  updateUserPassword = async (uid: string, password: string) => {
    try {
      const firebaseUser = await admin.auth().updateUser(uid, { password });
      return firebaseUser;
    } catch (err) {
      this.catchError(err.message);
    }
  };

  deleteUser = async (uid: string) => {
    try {
      await admin.auth().deleteUser(uid);
      return { message: "user deleted" };
    } catch (err) {
      this.catchError(err.message);
    }
  };

  sendPushNotifications = async (body: notificationBody) => {
    try {
      return admin.messaging().sendEachForMulticast(body);
    } catch (err) {
      this.catchError(err.message);
    }
  };

  catchError = (message: string) => {
    throw new Error(message);
  };

  googleAuth = async (token) => {
    return admin.auth().verifyIdToken(token);
  };

  verifyIdToken = (token: string) => {
    return admin.auth().verifyIdToken(token);
  };
}

export const firebaseService = new FirebaseAdminService();
