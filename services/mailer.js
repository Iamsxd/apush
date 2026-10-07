const nodemailer = require('nodemailer');
async function sendMail({host,port,user,pass,from,to,subject,html,text}) {
    if (!host || !user || !pass || !to) throw new Error('SMTP 配置不完整');
    const transport=nodemailer.createTransport({host,port:Number(port)||465,secure:Number(port)===465,requireTLS:Number(port)!==465,auth:{user,pass},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:10000,tls:{rejectUnauthorized:true}});
    try { await transport.sendMail({from:from||user,to,subject,html,text}); }
    finally { transport.close(); }
}
module.exports={sendMail};
