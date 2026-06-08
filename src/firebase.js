import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyC248mRTvwWMkKcsR1SLxL8Q4OOLsGb3t0",
  authDomain: "bm-tracker-b143d.firebaseapp.com",
  databaseURL: "https://bm-tracker-b143d-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "bm-tracker-b143d",
  storageBucket: "bm-tracker-b143d.firebasestorage.app",
  messagingSenderId: "680483250144",
  appId: "1:680483250144:web:f2b8e88838e69c1c2a9585"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
