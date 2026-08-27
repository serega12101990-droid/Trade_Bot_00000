/* eslint-disable @typescript-eslint/no-require-imports */
const os = require("node:os");
const { syncBuiltinESMExports } = require("node:module");

os.userInfo = () => ({
  username: process.env.USERNAME || "northstar",
  uid: -1,
  gid: -1,
  shell: null,
  homedir: process.env.USERPROFILE || process.cwd(),
});
syncBuiltinESMExports();
