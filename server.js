const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const moment = require('moment')
const QRCode = require('qrcode');
const FormData = require('form-data');
const fs = require('fs');
const {Catbox} = require('node-catbox')
const { GrpcStatus } = require('firebase-admin/firestore');
require('dotenv').config();
const app = express();
const port = process.env.PORT || 7860;

const serviceAccount = JSON.parse(process.env.admintoken);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Facebook verification token 
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

app.use(bodyParser.json());

let conversations = new Map();


class ConversationState {
  constructor(pageId = null, senderId = null, pageAccessToken = null) {
    this.step = 'START';
    this.pageId = pageId;
    this.senderId = senderId;
    this.pageAccessToken = pageAccessToken;
    this.appointmentData = {
      service: null,
      date: null,
      time: null,
      name: null,
      phone: null,
      note: null,
      image: null
    };
  }
}


const GREET_OPTION = {
  aboutus:"G_SHOW_ABOUT_US",
  appointment:"G_APPOINTMENT"
};

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(mode);

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

app.post('/webhook', (req, res) => {
  const body = req.body;
  console.log("log 62: "+JSON.stringify(body));
  if (body.object === 'page') {
    
    body.entry.forEach(entry => {
      let pageId = entry.id;
      entry.messaging.forEach(messagingEvent => {
        if (messagingEvent.message || messagingEvent.postback) {
          let userId = messagingEvent.sender.id; 
          handleMessage(messagingEvent,pageId,userId);
        }
      });
    });
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});
async function checkBlockUser(pageId, userId) {
  snapshot = await admin.firestore().collection('shops').doc(pageId).collection('users').doc(userId).get();
  if(snapshot.exists){
    const userData = snapshot.data();
    const today = new Date();
    switch (userData.blockType){
      case "NONE":
        return false;
        break
      case "DAY3":
        if(userData.expiredBlockDate.toDate() < today){
          return false;
        }
        else{
          sendTextMessage(pageId,userId,`Bạn bị block 3 ngày, gỡ block vào ngày ${userData.expiredBlockDate.toDate()}`)
          return true;
          break;
        }
      case "FOREVER":
          sendTextMessage(pageId,userId,`Bạn đã bị block`)
          return true;
          break;
    }
  }
  else{
    return false;
  }
  return false;
}
async function handleMessage(event,pageId,userId) {
  const senderId = userId;
  const conversationKey = `${pageId}-${senderId}`;
  

  if (!conversations.has(conversationKey)) {
    conversations.set(conversationKey, new ConversationState(pageId,senderId,await getPageAccessToken(pageId)));
    
  }
  const conversation = conversations.get(conversationKey);
  
  if(await checkBlockUser(pageId,senderId)){
    
    return
  }

  let message;
  let attachments;
  if (event.postback) {
    message = event.postback.payload;
  } else if (event.message) {
    if(event.message.quick_reply){
      message = event.message.quick_reply.payload;
    }
    else{
      message = event.message.text;
      attachments = event.message.attachments;
    }
  }
  if(message == ".exit"){
    sendTextMessage(pageId,senderId,"deleted");
    conversations.delete(conversationKey);
    return;
  }

  try {
    switch (conversation.step) {
      case 'START':
        await sendGreeting(pageId, senderId);
        conversation.step = 'AWAITING_GREET';
        break;
      case 'AWAITING_GREET': 
        if(message == GREET_OPTION.aboutus){
          let userinfor = await getUserPageInfor(pageId).then(res => res);
          const aboutmessage = `Thông tin liên hệ: \n\n`+
                                `Tên chủ quán:${userinfor.name}\n`+
                                `Số Điện thoại:${userinfor.sdt}\n`+
                                `Địa chỉ:${userinfor.address}\n`;
          
          await sendAboutUsReply(pageId,userId,aboutmessage);
          conversation.step = 'START'
          break;
        }
        else if(message == GREET_OPTION.appointment){
          await sendServiceOptions(pageId,senderId);
          conversation.step = 'AWAITING_SERVICE';
          break
        }

        
      case 'AWAITING_SERVICE':
        const Services = await getPageServices(pageId).then(res => res);
        const service = Services.find(s => s.id === message);
        if (service) {
          conversation.appointmentData.service = service;
         
          await sendDateOptions(pageId,senderId);
          conversation.step = 'AWAITING_DATE';
        } else {
          await sendTextMessage(pageId, senderId, "Vui lòng chọn dịch vụ");
        }
        break;
      case 'AWAITING_DATE':
        if (moment(message, 'DD/MM/YYYY', true).isValid()) {
          conversation.appointmentData.date = message;
          await sendTimeOptions(pageId, senderId);
          conversation.step = 'AWAITING_TIME';
        } else {
          await sendTextMessage(pageId, senderId, "Please chọn ngày hoặc gửi .exit để hủy");
          await sendDateOptions(pageId,senderId)
        }
        break;
      case 'AWAITING_TIME':
        if (moment(message, 'HH:mm', true).isValid()) {
          conversation.appointmentData.time = message;
          // cant get user name because of this: https://developers.facebook.com/docs/messenger-platform/identity/user-profile/
          const senderName = (await getSenderInfor(pageId,senderId)).senderName;
          if(senderName != "" && senderName != null && senderName != undefined){
            await sendQuickReply(pageId, senderId, "Nhập tên của bạn:", senderName);
          }
          else sendTextMessage(pageId,senderId,"Nhập tên của bạn:");

          conversation.step = 'AWAITING_NAME';
        } else {
          await sendTextMessage(pageId, senderId, "Please enter thời gian hoặc gửi .exit để hủy");
          await sendTimeOptions(pageId,senderId)
        }
        break;
      case 'AWAITING_NAME':
        conversation.appointmentData.name = message;
        await sendQuickReplyPhone(pageId, senderId, "Nhập số điện thoại:");
        conversation.step = 'AWAITING_PHONE';
        break;
      case 'AWAITING_PHONE':
        conversation.appointmentData.phone = message;
        sendTextMessage(pageId,senderId,`bạn có nhắn gửi gì cho chủ quán không? `)
        conversation.step = 'AWAITING_NOTE';
        break;
      case 'AWAITING_NOTE':
        conversation.appointmentData.note = message;
        await sendTextMessage(pageId, senderId, "bạn có ảnh mẫu để quán tham khảo không?");
        conversation.step = 'AWAITING_IMAGE';
        break;
      case 'AWAITING_IMAGE': 
        
        if(attachments){
          attachments.forEach(attachment => {
            if (attachment.type === 'image') {
              const imageUrl = attachment.payload.url;
              conversation.appointmentData.image = imageUrl;
            }
          })
        }
        await sendTextMessage(pageId, senderId, "ok đã ghi nhận lịch hẹn");
        await sendConfirmation(pageId, senderId, conversation.appointmentData);
        conversation.step = 'AWAITING_CONFIRMATION';
        break;
      case 'AWAITING_CONFIRMATION':
        if (message.toLowerCase() === 'yes') {
          await handleConfirmation(pageId, senderId, conversation.appointmentData);
          conversations.delete(conversationKey);
        } else {
          await sendTextMessage(pageId, senderId, "Đã hủy hẹn, nhắn gì đó để bắt đầu lại");
          conversations.delete(conversationKey);
        }
        break;
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await sendTextMessage(pageId, senderId, "Sorry, something went wrong. Please try again.");
    conversations.delete(conversationKey);
  }

  
}
async function sendGreeting(pageId,senderId){
  const messageData = {
    recipient: {id: senderId},
    message: {
      attachment:{
        type: "template",
        payload: {
          template_type: "generic",
          elements:[
            {
              title: "Xin chào!",
              image_url:"https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQB-BV7aC-cVrVPzpOWqlXKOct6XltbcoSggQ&s",
              subtitle: "chào mừng bạn, nếu cần giúp đỡ, hãy xem các lựa chọn sau",
              buttons:[
                {
                  title: "về chúng tôi",
                  type: "postback",
                  payload: GREET_OPTION.aboutus,
                },
                {
                  title: "Đặt lịch hẹn",
                  type: "postback",
                  payload: GREET_OPTION.appointment,
                }
              ]
            }
          ]
        }
      }
    }
  }
  const conversationKey = `${pageId}-${senderId}`;
  const conversation = conversations.get(conversationKey)
  await sendToMessenger(conversation, messageData);
}
async function sendServiceOptions(pageId, senderId) {
  const Services = await getPageServices(pageId).then(res => res);
  const messageData = {
    recipient: { id: senderId },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: Services.map(service => ({
            title: service.name,
            subtitle: `Thời gian: ${service.duration} Phút, giá: ${service.price} VND`,
            buttons: [{
              type: "postback",
              title: "Select",
              payload: service.id
            }]
          }))
        }
      }
    }
  };
  
  const conversationKey = `${pageId}-${senderId}`;
  const conversation = conversations.get(conversationKey)
  await sendToMessenger(conversation, messageData);
}
async function sendDateOptions(pageId, senderId) {

  const dates = Array.from({length: 8}, (_, i) => {
    const date = moment().add(i , 'days');
    return {
      content_type: "text",
      title: date.format('DD/MM'),
      payload: date.format('DD/MM/YYYY')
    };
  });

  const messageData = {
    recipient: { id: senderId },
    message: {
      text: "Chọn ngày:",
      quick_replies: dates
    }
  };

  const conversationKey = `${pageId}-${senderId}`;
  const conversation = conversations.get(conversationKey)
  await sendToMessenger(conversation, messageData);
}

async function sendTimeOptions(pageId, senderId) {
  const times = ['08:00','09:00','10:00', '11:00','13:00', '14:00', '15:00', '16:00'].map(time => ({
    content_type: "text",
    title: time,
    payload: time
  }));

  const messageData = {
    recipient: { id: senderId },
    message: {
      text: "Chọn khung giờ:",
      quick_replies: times
    }
  };

  const conversationKey = `${pageId}-${senderId}`;
  const conversation = conversations.get(conversationKey)
  await sendToMessenger(conversation, messageData);
}
async function sendQuickReply(pageId, senderId, text, quick_reply) {
  
  const messageData = {
    recipient: { id: senderId },
    message: { 
      text,
      quick_replies : [
        {
          content_type: "text",
          title: quick_reply,
          payload: quick_reply
        }
      ]
    }
  };
  
  const conversationKey = `${pageId}-${senderId}`;
  const conversation = conversations.get(conversationKey)
  await sendToMessenger(conversation, messageData);
}
async function sendQuickReplyPhone(pageId, senderId, text) {
  const messageData = {
    recipient: { id: senderId },
    message: { 
      text,
      quick_replies : [
        {
          content_type: "user_phone_number",
          
        }
      ]
    }
  };
  
  const conversationKey = `${pageId}-${senderId}`;
  const conversation = conversations.get(conversationKey)
  await sendToMessenger(conversation, messageData);
}

async function sendTextMessage(pageId, senderId, text) {
  const messageData = {
    recipient: { id: senderId },
    message: { text }
  };
  
  const conversationKey = `${pageId}-${senderId}`;
  const conversation = conversations.get(conversationKey)
  await sendToMessenger(conversation, messageData);
}

async function sendConfirmation(pageId,senderId, appointmentData){
  let textMessage = 
  "Đặt lịch như này:\n\n"+
  `Dịch vụ: ${appointmentData.service.name}\n`+
  `Sdt: ${appointmentData.phone} \n`+
  `Tên: ${appointmentData.name}\n`+
  `Note: ${appointmentData.note}\n`+
  `Ngày: ${appointmentData.date}\n`+
  `Thời gian: ${appointmentData.time}\n`+
  `nhắn "yes" để xác nhận hoặc ".no" để hủy`;
  sendTextMessage(pageId,senderId,textMessage);

}
async function handleConfirmation(pageId,senderId,appointmentData) {
  await sendTextMessage(pageId,senderId,"Cảm ơn bạn, bạn sẽ được thông báo sau khi chủ quán xác nhận");
  // Send FCM notification to salon owner
  const message = {
    token: process.env.DEVICE_TOKEN,
    data: {
      type: 'appointment',
      service: appointmentData.service.name || "isnull",
      date: appointmentData.date || "isnull",
      time: appointmentData.time || "isnull",
      customerName: appointmentData.name || "isnull",
      customerPhone: appointmentData.phone || "isnull",
      messengerUserId: senderId || "isnull",
      referencePicture: appointmentData.image || "isnull",
      note: appointmentData.note || "isnull"
    }
  };
  try{
    const fcmresponse = await admin.messaging().send(message);
    console.log('Successfully sent message:', fcmresponse);
  }
  catch (error){
    console.error("error sending data to fcm: " + error);
  }
  
}
async function sendAboutUsReply(pageId,senderId, aboutmessage){
  const messageData = {
    recipient: { id: senderId },
    message: { 
      text: aboutmessage,
      quick_replies:[
      {
        content_type:"text",
        title:"Menu",
        payload:"G_MENU",
      
      }
    ] 
    }
  };
  const conversationKey = `${pageId}-${senderId}`;
  const conversation = conversations.get(conversationKey)
  await sendToMessenger(conversation, messageData);
}
async function sendToMessenger(conversation, messageData) {
  const pageAccessToken = conversation.pageAccessToken;
  
  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${pageAccessToken}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messageData),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Error sending message: ${errorData.error.message}`);
    }
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
  
}
async function getPageAccessToken(pageId){
  
    //TODO: lookup pageid on firebase db
  doc = await admin.firestore().collection('shops').doc(pageId).get();
  if(!doc.exists){
    console.log("fail to retrive page access token ");
    return ""
  }
  else{
    return doc.get("pageAccessToken");
    
  }
    

}
async function getPageServices(pageId){
  let services = [];
  snapshot = await admin.firestore().collection('shops').doc(pageId).collection('services').get();
  if(snapshot.empty){
    console.log("noservice");
  }
  else{
    snapshot.forEach(ser => {
      services.push(ser.data())
    })
    
  }
  
  return services;
}
async function getSenderInfor(pageId,senderId){
  const pageAccessToken = await getPageAccessToken(pageId);
  const senderInfo = {
    senderName: "",
    senderPhone: ""
  }
  try {
    const response = await fetch(
      `https://graph.facebook.com/${senderId}?fields=name&access_token=${pageAccessToken}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        }
      }
    ).then(res => res.json()).then(res => {
      senderInfo.senderName = res.name;
    });
    console.log(senderInfo.senderName);
    return senderInfo;
  } catch (error) {
    console.error('Error rror retrive user data', error);
    throw error;
  }
}
async function getUserPageInfor(pageId) {
  return {
    name: "Thành",
    sdt: "0483728375",
    address: "123 Đường 2/4 Nha Trang"
  }
}
app.get('/lolo',(req,res) => {
    console.log("hello")
    const event = {
        sender: {
            id: '12231313'
        },
        message: {
            text: "hello from lolo"
        },
        recipient: {
            id: 'foekieu'
        },
        timestamp: "1122"
    }

  
    res.status(200).send('EVENT_RECEIVED');

})
app.post('/receive-qr-data', (req, res) => {
  const { pageid, psid, apid } = req.body;

  if (!pageid || !psid || !apid) {
    return res.status(400).json({ error: 'Missing kek' });
  }

  handleQrRequest(pageid,apid);

  // Log the received data (you can do whatever you want with it here)
  console.log('Received data:', { pageid, apid });



  res.status(200).json({ message: 'Data received successfully', receivedData: { pageid, apid }});
});

async function handleQrRequest(pageid,apid) {

  
  snapshot = await admin.firestore().collection('shops').doc(pageid).collection('appointments').doc(apid).get();
  if(snapshot.exists){
    const appointmentData = snapshot.data();
    
    //sendTextAsQRToMessenger(appointmentData.appointmentId,"qr-code.png",pageid,appointmentData.messengerUserId)
    QRCode.toFile('qr-code.png', apid, {
      color: {
        dark: '#000000',  
        light: '#ffffff' 
      }
    }, function (err) {
      if (err) {
        console.error('Error generating QR code:', err);
      } else {
        UploadToCatbox("qr-code.png").then(qrurl => {
          sendImageToMessenger(pageid,appointmentData.messengerUserId,qrurl);
        });
        //sendImageToMessenger(pageid,appointmentData.messengerUserId,"qr-code.png")
      }
    });
  }
  
}
async function UploadToCatbox(imageFileName){
  const imagePath = path.join(__dirname, imageFileName);
  const catbox = new Catbox();

        try {
          const response = await catbox.uploadFile({
            path: "qr-code.png"
          });
          

          console.log(response); // -> https://files.catbox.moe/XXXXX.ext
          return response
        } catch (err) {
          console.error(err); // -> error message from server
        }
}
async function sendImageToMessenger(pageId, senderId, imageUrl) {
  const pageAccessToken = await getPageAccessToken(pageId);


  try {
    
    const messageWithImage = {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: 'image',
          payload: {
            url : imageUrl,
          },
        },
      },
    };
 

    const response = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${pageAccessToken}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messageWithImage),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Error sending message: ${errorData.error.message}`);
    }

  } catch (error) {
    console.error('Error sending image message:', error);
    throw error;
  }
}


app.get('/', (req,res) => {
  res.status(200).send('hello')
})
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});



