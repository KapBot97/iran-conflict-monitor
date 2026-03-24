/**
 * Email alert utility for Iran Monitor
 * Uses Gmail (akbotassistant@gmail.com) via nodemailer
 */

const nodemailer = require('nodemailer');

const GMAIL_USER = 'akbotassistant@gmail.com';
const GMAIL_APP_PASSWORD = 'zxrx tqyt lqkd enbk';

const RECIPIENTS = [
  'golden@kineticpartners.com',
  'kapoor@kineticpartners.com',
];

function createTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });
}

async function sendAlert({ subject, text, html }) {
  const transporter = createTransport();
  const info = await transporter.sendMail({
    from: `"Iran Monitor" <${GMAIL_USER}>`,
    to: RECIPIENTS.join(', '),
    subject,
    text,
    html: html || undefined,
  });
  return info;
}

module.exports = { sendAlert, RECIPIENTS };
