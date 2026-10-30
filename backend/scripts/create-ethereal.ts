import nodemailer from "nodemailer";

const account = await nodemailer.createTestAccount();
console.info("Ethereal SMTP account created. Add this sender object to backend/.env:");
console.info(JSON.stringify({
  id: "ethereal-one",
  email: account.user,
  host: "smtp.ethereal.email",
  port: 587,
  secure: false,
  user: account.user,
  pass: account.pass
}, null, 2));
