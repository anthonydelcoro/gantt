/* Firebase project settings.
   Safe to commit. This identifies the project, it does not grant access.
   Access is controlled entirely by the database rules, which restrict reads
   and writes to verified @vt.edu Google accounts. */

export const firebaseConfig = {
  apiKey: "AIzaSyBKwq3EcrC7bb21c_rN04turMOlmbFqmzM",
  authDomain: "gantt-chart-bf9ce.firebaseapp.com",
  databaseURL: "https://gantt-chart-bf9ce-default-rtdb.firebaseio.com",
  projectId: "gantt-chart-bf9ce",
  storageBucket: "gantt-chart-bf9ce.firebasestorage.app",
  messagingSenderId: "228752536718",
  appId: "1:228752536718:web:3193fcf11d740c3f3905df"
};

/* Only accounts on this domain can sign in. The database rules enforce the
   same thing on the server, this just gives a clearer message in the browser. */
export const ALLOWED_DOMAIN = "vt.edu";

/* Where the schedule lives in the database. Change this if you ever want a
   second, separate chart in the same Firebase project. */
export const SCHEDULE_PATH = "schedule";
