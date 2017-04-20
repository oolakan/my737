'use strict';

const apiai = require('apiai');
const express = require('express');
const bodyParser = require('body-parser');
const uuid = require('node-uuid');
const request = require('request');
const JSONbig = require('json-bigint');
const async = require('async');

const REST_PORT = (process.env.PORT || 5000);
const APIAI_ACCESS_TOKEN = process.env.APIAI_ACCESS_TOKEN;
const APIAI_LANG = process.env.APIAI_LANG || 'en';
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FB_TEXT_LIMIT = 640;
var sender_id = "";

class FacebookBot {
    constructor() {
        this.apiAiService = apiai(APIAI_ACCESS_TOKEN, { language: APIAI_LANG, requestSource: "fb" });
        this.sessionIds = new Map();
        this.messagesDelay = 200;
    }


    doDataResponse(sender, facebookResponseData) {
        if (!Array.isArray(facebookResponseData)) {
            console.log('Response as formatted message');
            this.sendFBMessage(sender, facebookResponseData)
                .catch(err => console.error(err));
        } else {
            async.eachSeries(facebookResponseData, (facebookMessage, callback) => {
                if (facebookMessage.sender_action) {
                    console.log('Response as sender action');
                    this.sendFBSenderAction(sender, facebookMessage.sender_action)
                        .then(() => callback())
                        .catch(err => callback(err));
                } else {
                    console.log('Response as formatted message');
                    this.sendFBMessage(sender, facebookMessage)
                        .then(() => callback())
                        .catch(err => callback(err));
                }
            }, (err) => {
                if (err) {
                    console.error(err);
                } else {
                    console.log('Data response completed');
                }
            });
        }
    }

    doRichContentResponse(sender, messages) {
        let facebookMessages = []; // array with result messages

        for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
            let message = messages[messageIndex];

            switch (message.type) {
                //message.type 0 means text message
                case 0:
                    // speech: ["hi"]
                    // we have to get value from fulfillment.speech, because of here is raw speech
                    if (message.speech) {

                        let splittedText = this.splitResponse(message.speech);

                        splittedText.forEach(s => {
                            facebookMessages.push({ text: s });
                        });
                    }

                    break;
                    //message.type 1 means card message
                case 1:
                    {
                        let carousel = [message];

                        for (messageIndex++; messageIndex < messages.length; messageIndex++) {
                            if (messages[messageIndex].type == 1) {
                                carousel.push(messages[messageIndex]);
                            } else {
                                messageIndex--;
                                break;
                            }
                        }

                        let facebookMessage = {};
                        carousel.forEach((c) => {
                            // buttons: [ {text: "hi", postback: "postback"} ], imageUrl: "", title: "", subtitle: ""

                            let card = {};

                            card.title = c.title;
                            card.image_url = c.imageUrl;
                            if (this.isDefined(c.subtitle)) {
                                card.subtitle = c.subtitle;
                            }
                            //If button is involved in.
                            if (c.buttons.length > 0) {
                                let buttons = [];
                                for (let buttonIndex = 0; buttonIndex < c.buttons.length; buttonIndex++) {
                                    let button = c.buttons[buttonIndex];

                                    if (button.text) {
                                        let postback = button.postback;
                                        if (!postback) {
                                            postback = button.text;
                                        }

                                        let buttonDescription = {
                                            title: button.text
                                        };

                                        if (postback.startsWith("http")) {
                                            buttonDescription.type = "web_url";
                                            buttonDescription.url = postback;
                                        } else {
                                            buttonDescription.type = "postback";
                                            buttonDescription.payload = postback;
                                        }

                                        buttons.push(buttonDescription);
                                    }
                                }

                                if (buttons.length > 0) {
                                    card.buttons = buttons;
                                }
                            }

                            if (!facebookMessage.attachment) {
                                facebookMessage.attachment = { type: "template" };
                            }

                            if (!facebookMessage.attachment.payload) {
                                facebookMessage.attachment.payload = { template_type: "generic", elements: [] };
                            }

                            facebookMessage.attachment.payload.elements.push(card);
                        });

                        facebookMessages.push(facebookMessage);
                    }

                    break;
                    //message.type 2 means quick replies message
                case 2:
                    {
                        if (message.replies && message.replies.length > 0) {
                            let facebookMessage = {};

                            facebookMessage.text = message.title ? message.title : 'Choose an item';
                            facebookMessage.quick_replies = [];

                            message.replies.forEach((r) => {
                                facebookMessage.quick_replies.push({
                                    content_type: "text",
                                    title: r,
                                    payload: r
                                });
                            });

                            facebookMessages.push(facebookMessage);
                        }
                    }

                    break;
                    //message.type 3 means image message
                case 3:

                    if (message.imageUrl) {
                        let facebookMessage = {};

                        // "imageUrl": "http://example.com/image.jpg"
                        facebookMessage.attachment = { type: "image" };
                        facebookMessage.attachment.payload = { url: message.imageUrl };

                        facebookMessages.push(facebookMessage);
                    }

                    break;
                    //message.type 4 means custom payload message
                case 4:
                    if (message.payload && message.payload.facebook) {
                        facebookMessages.push(message.payload.facebook);
                    }
                    break;

                default:
                    break;
            }
        }

        return new Promise((resolve, reject) => {
            async.eachSeries(facebookMessages, (msg, callback) => {
                    this.sendFBSenderAction(sender, "typing_on")
                        .then(() => this.sleep(this.messagesDelay))
                        .then(() => this.sendFBMessage(sender, msg))
                        .then(() => callback())
                        .catch(callback);
                },
                (err) => {
                    if (err) {
                        console.error(err);
                        reject(err);
                    } else {
                        console.log('Messages sent');
                        resolve();
                    }
                });
        });

    }

    doTextResponse(sender, responseText) {
            console.log('Response as text message');
            // facebook API limit for text length is 640,
            // so we must split message if needed
            let splittedText = this.splitResponse(responseText);

            async.eachSeries(splittedText, (textPart, callback) => {
                this.sendFBMessage(sender, { text: textPart })
                    .then(() => callback())
                    .catch(err => callback(err));
            });
        }
        //which webhook event
    getEventText(event) {
        if (event.message) {
            if (event.message.quick_reply && event.message.quick_reply.payload) {
                return event.message.quick_reply.payload;
            }

            if (event.message.text) {
                return event.message.text;
            }
        }

        if (event.postback && event.postback.payload) {
            return event.postback.payload;
        }

        return null;

    }

    processEvent(event) {
        const sender = event.sender.id.toString();
        //this can be used globally
        sender_id = sender;
        const text = this.getEventText(event);
        const messageAttachments = message.attachments;

        if (text) {

            // Handle a text message from this sender
            if (!this.sessionIds.has(sender)) {
                this.sessionIds.set(sender, uuid.v4());
            }

            console.log("Text", text);
            //send user's text to api.ai service
            let apiaiRequest = this.apiAiService.textRequest(text, {
                sessionId: this.sessionIds.get(sender),
                originalRequest: {
                    data: event,
                    source: "facebook"
                }
            });
            //get response from api.ai
            apiaiRequest.on('response', (response) => {
                if (this.isDefined(response.result) && this.isDefined(response.result.fulfillment)) {
                    let responseText = response.result.fulfillment.speech;
                    let responseData = response.result.fulfillment.data;
                    let responseMessages = response.result.fulfillment.messages;
                    let responseAction = response.result.action;
                    let action = response.result.action;
                    if (action == 'onboard737Service.onboard737Service-yes') {
                        sendTypingOn(sender);
                        sendOnBoardMessage(sender);
                    } else if (action === 'openaccount.openaccount-yes') {
                        sendTypingOn(sender);
                        sendOpenAccountMessage(sender);
                    } else if (action === 'openaccount.openaccount-no') {
                        sendTypingOn(sender);
                        sendOpenAccountMessage(sender);

                    } else if (action == 'location.search') {
                        sendLocation(sender);

                    } else {
                        if (this.isDefined(responseData) && this.isDefined(responseData.facebook)) {
                            let facebookResponseData = responseData.facebook;
                            this.doDataResponse(sender, facebookResponseData);
                        } else if (this.isDefined(responseMessages) && responseMessages.length > 0) {
                            this.doRichContentResponse(sender, responseMessages);
                        } else if (this.isDefined(responseText)) {
                            this.doTextResponse(sender, responseText);
                        }
                    }
                }
            });

            apiaiRequest.on('error', (error) => console.error(error));
            apiaiRequest.end();
        } else if (messageAttachments) {
            var locationLat = messageAttachments[0].payload.coordinates.lat;
            var locationLong = messageAttachments[0].payload.coordinates.long;
            var locations = getAllLocation(locationLat, locationLong);
            sendTextMessage(locations);
            // sendTextMessage(senderID, locationLat + ", " + locationLong);
        }
    }
    splitResponse(str) {
        if (str.length <= FB_TEXT_LIMIT) {
            return [str];
        }

        return this.chunkString(str, FB_TEXT_LIMIT);
    }

    chunkString(s, len) {
        let curr = len,
            prev = 0;

        let output = [];

        while (s[curr]) {
            if (s[curr++] == ' ') {
                output.push(s.substring(prev, curr));
                prev = curr;
                curr += len;
            } else {
                let currReverse = curr;
                do {
                    if (s.substring(currReverse - 1, currReverse) == ' ') {
                        output.push(s.substring(prev, currReverse));
                        prev = currReverse;
                        curr = currReverse + len;
                        break;
                    }
                    currReverse--;
                } while (currReverse > prev)
            }
        }
        output.push(s.substr(prev));
        return output;
    }

    sendFBMessage(sender, messageData) {
        return new Promise((resolve, reject) => {
            request({
                url: 'https://graph.facebook.com/v2.6/me/messages',
                qs: { access_token: FB_PAGE_ACCESS_TOKEN },
                method: 'POST',
                json: {
                    recipient: { id: sender },
                    message: messageData
                }
            }, (error, response) => {
                if (error) {
                    console.log('Error sending message: ', error);
                    reject(error);
                } else if (response.body.error) {
                    console.log('Error: ', response.body.error);
                    reject(new Error(response.body.error));
                }

                resolve();
            });
        });
    }

    sendFBSenderAction(sender, action) {
        return new Promise((resolve, reject) => {
            request({
                url: 'https://graph.facebook.com/v2.6/me/messages',
                qs: { access_token: FB_PAGE_ACCESS_TOKEN },
                method: 'POST',
                json: {
                    recipient: { id: sender },
                    sender_action: action
                }
            }, (error, response) => {
                if (error) {
                    console.error('Error sending action: ', error);
                    reject(error);
                } else if (response.body.error) {
                    console.error('Error: ', response.body.error);
                    reject(new Error(response.body.error));
                }

                resolve();
            });
        });
    }

    doSubscribeRequest() {
        request({
                method: 'POST',
                uri: "https://graph.facebook.com/v2.6/me/subscribed_apps?access_token=" + FB_PAGE_ACCESS_TOKEN
            },
            (error, response, body) => {
                if (error) {
                    console.error('Error while subscription: ', error);
                } else {
                    console.log('Subscription result: ', response.body);
                }
            });
    }

    isDefined(obj) {
        if (typeof obj == 'undefined') {
            return false;
        }

        if (!obj) {
            return false;
        }

        return obj != null;
    }

    sleep(delay) {
        return new Promise((resolve, reject) => {
            setTimeout(() => resolve(), delay);
        });
    }

}


let facebookBot = new FacebookBot();

const app = express();

app.use(bodyParser.text({ type: 'application/json' }));

app.get('/webhook/', (req, res) => {
    if (req.query['hub.verify_token'] == FB_VERIFY_TOKEN) {
        res.send(req.query['hub.challenge']);

        setTimeout(() => {
            facebookBot.doSubscribeRequest();
        }, 3000);
    } else {
        res.send('Error, wrong validation token');
    }
});
//post users data and get response
app.post('/webhook/', (req, res) => {
    const data = JSONbig.parse(req.body);
    try {
        if (data.entry) {
            let entries = data.entry;
            entries.forEach((entry) => {
                let messaging_events = entry.messaging;
                if (messaging_events) {
                    messaging_events.forEach((event) => {
                        if (event.message && !event.message.is_echo ||
                            event.postback && event.postback.payload) {
                            facebookBot.processEvent(event);
                        }
                    });
                }
            });
        }

        return res.status(200).json({
            status: "ok"
        });
    } catch (err) {
        return res.status(400).json({
            status: "error",
            error: err
        });
    }
    // }
});

//facebook bot code
/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var delivery = event.delivery;
    var messageIDs = delivery.mids;
    var watermark = delivery.watermark;
    var sequenceNumber = delivery.seq;

    if (messageIDs) {
        messageIDs.forEach(function(messageID) {
            console.log("Received delivery confirmation for message ID: %s",
                messageID);
        });
    }

    console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfPostback = event.timestamp;

    // The 'payload' param is a developer-defined field which is set in a postback 
    // button for Structured Messages. 
    var payload = event.postback.payload;

    console.log("Received postback for user %d and page %d with payload '%s' " +
        "at %d", senderID, recipientID, payload, timeOfPostback);

    // When a postback is called, we'll send a message back to the sender to 
    // let them know it was successful
    sendTextMessage(senderID, "Postback called");
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    // All messages before watermark (a timestamp) or sequence have been seen.
    var watermark = event.read.watermark;
    var sequenceNumber = event.read.seq;

    console.log("Received message read event for watermark %d and sequence " +
        "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    var status = event.account_linking.status;
    var authCode = event.account_linking.authorization_code;

    console.log("Received account link event with for user %d with status %s " +
        "and auth code %s ", senderID, status, authCode);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "image",
                payload: {
                    url: SERVER_URL + "/assets/rift.png"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "image",
                payload: {
                    url: SERVER_URL + "/assets/instagram_logo.gif"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "audio",
                payload: {
                    url: SERVER_URL + "/assets/sample.mp3"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendVideoMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "video",
                payload: {
                    url: SERVER_URL + "/assets/allofus480.mov"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a file using the Send API.
 *
 */
function sendFileMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "file",
                payload: {
                    url: SERVER_URL + "/assets/test.txt"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: messageText,
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a on baord message using the Send API.
 *
 */
function sendOnBoardMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Input your last 9 digits of card, expiry date and card pin?",
                    buttons: [{
                        type: "web_url",
                        url: __dirname + "/views/onboard.html",
                        title: "Click here to get onboarded",
                        webview_height_ratio: "compact"
                    }]
                }
            }
        }
    };

    callSendAPI(messageData);
}

//get post data from onboard webview
var express = require('express');
var app = express();
var bodyParser = require('body-parser');
var urlencodedParser = bodyParser.urlencoded({ extended: false });
app.use(express.static('public'));
app.post('/onboard', urlencodedParser, function(request, response) {
    res = {
        card_digits: request.body.card_digits,
        expiry_date: request.body.expiry_date,
        card_pin: request.body.card_pin,
    };
    //this.doTextResponse(sender_id, JSON.stringify(res));
    sendTextMessage(sender_id, JSON.stringify(res))
    console.log(res);
    response.end(JSON.stringify(res));
});


//facebook bot code
/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var delivery = event.delivery;
    var messageIDs = delivery.mids;
    var watermark = delivery.watermark;
    var sequenceNumber = delivery.seq;

    if (messageIDs) {
        messageIDs.forEach(function(messageID) {
            console.log("Received delivery confirmation for message ID: %s",
                messageID);
        });
    }

    console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfPostback = event.timestamp;

    // The 'payload' param is a developer-defined field which is set in a postback 
    // button for Structured Messages. 
    var payload = event.postback.payload;

    console.log("Received postback for user %d and page %d with payload '%s' " +
        "at %d", senderID, recipientID, payload, timeOfPostback);

    // When a postback is called, we'll send a message back to the sender to 
    // let them know it was successful
    sendTextMessage(senderID, "Postback called");
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    // All messages before watermark (a timestamp) or sequence have been seen.
    var watermark = event.read.watermark;
    var sequenceNumber = event.read.seq;

    console.log("Received message read event for watermark %d and sequence " +
        "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    var status = event.account_linking.status;
    var authCode = event.account_linking.authorization_code;

    console.log("Received account link event with for user %d with status %s " +
        "and auth code %s ", senderID, status, authCode);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "image",
                payload: {
                    url: SERVER_URL + "/assets/rift.png"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "image",
                payload: {
                    url: SERVER_URL + "/assets/instagram_logo.gif"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "audio",
                payload: {
                    url: SERVER_URL + "/assets/sample.mp3"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendVideoMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "video",
                payload: {
                    url: SERVER_URL + "/assets/allofus480.mov"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a file using the Send API.
 *
 */
function sendFileMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "file",
                payload: {
                    url: SERVER_URL + "/assets/test.txt"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: messageText,
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a on baord message using the Send API.
 *
 */
function sendOnBoardMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Input your last 9 digits of card, expiry date and card pin?",
                    buttons: [{
                        type: "web_url",
                        url: "http://www.highstrit.com/",
                        title: "Click here to get onboarded",
                        webview_height_ratio: "compact"
                    }]
                }
            }
        }
    };

    callSendAPI(messageData);
}



/*
 * Send a open account message using the Send API.
 *
 */
function sendOpenAccountMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Enter BVN?",
                    buttons: [{
                        type: "web_url",

                        url: __dirname + "/views/onboard.html",

                        url: "http://www.highstrit.com/",

                        title: "Click here to enter BVN",
                        webview_height_ratio: "compact"
                    }]
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "generic",
                    elements: [{
                            title: "rift",
                            subtitle: "Next-generation virtual reality",
                            item_url: "http://www.highstrit.com/",
                            image_url: SERVER_URL + "/assets/rift.png",
                            buttons: [{
                                type: "web_url",
                                url: "http://www.highstrit.com/",
                                title: "Open Web URL",
                                webview_height_ratio: "compact"
                            }, {
                                type: "postback",
                                title: "Call Postback",
                                payload: "Payload for first bubble",
                            }],
                        },
                        {
                            title: "rift",
                            subtitle: "Next-generation virtual reality",
                            item_url: "http://www.highstrit.com/",
                            image_url: SERVER_URL + "/assets/rift.png",
                            buttons: [{
                                type: "web_url",
                                url: "http://www.highstrit.com/",
                                title: "Open Web URL",
                                webview_height_ratio: "compact"
                            }, {
                                type: "postback",
                                title: "Call Postback",
                                payload: "Payload for first bubble",
                            }],
                        },

                        {
                            title: "touch",
                            subtitle: "Your Hands, Now in VR",
                            item_url: "http://www.highstrit.com/",
                            image_url: SERVER_URL + "/assets/touch.png",
                            buttons: [{
                                type: "web_url",
                                url: "http://www.highstrit.com/",
                                title: "Open Web URL",
                                webview_height_ratio: "compact"
                            }, {
                                type: "postback",
                                title: "Call Postback",
                                payload: "Payload for second bubble",
                            }]
                        }
                    ]
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a receipt message using the Send API.
 *
 */
function sendReceiptMessage(recipientId) {
    // Generate a random receipt ID as the API requires a unique ID
    var receiptId = "order" + Math.floor(Math.random() * 1000);

    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "receipt",
                    recipient_name: "Peter Chang",
                    order_number: receiptId,
                    currency: "USD",
                    payment_method: "Visa 1234",
                    timestamp: "1428444852",
                    elements: [{
                        title: "Oculus Rift",
                        subtitle: "Includes: headset, sensor, remote",
                        quantity: 1,
                        price: 599.00,
                        currency: "USD",
                        image_url: SERVER_URL + "/assets/riftsq.png"
                    }, {
                        title: "Samsung Gear VR",
                        subtitle: "Frost White",
                        quantity: 1,
                        price: 99.99,
                        currency: "USD",
                        image_url: SERVER_URL + "/assets/gearvrsq.png"
                    }],
                    address: {
                        street_1: "1 Hacker Way",
                        street_2: "",
                        city: "Menlo Park",
                        postal_code: "94025",
                        state: "CA",
                        country: "US"
                    },
                    summary: {
                        subtotal: 898.99,
                        shipping_cost: 20.00,
                        total_tax: 57.67,
                        total_cost: 626.66
                    },
                    adjustments: [{
                        name: "New Customer Discount",
                        amount: -50
                    }, {
                        name: "$100 Off Coupon",
                        amount: -100
                    }]
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: "Select any option",
            quick_replies: [{
                    "content_type": "text",
                    "title": "Action",
                    "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_ACTION"
                },
                {
                    "content_type": "text",
                    "title": "Comedy",
                    "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_COMEDY"
                },
                {
                    "content_type": "text",
                    "title": "Drama",
                    "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_DRAMA"
                }
            ]
        }
    };

    callSendAPI(messageData);
}

function sendLocation(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        "message": {
            "text": "Please share your location:",
            "quick_replies": [{
                "content_type": "location",
            }]
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
    console.log("Sending a read receipt to mark message as seen");

    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "mark_seen"
    };

    callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
    console.log("Turning typing indicator on");

    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_on"
    };

    callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
    console.log("Turning typing indicator off");

    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_off"
    };

    callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Welcome. Link your account.",
                    buttons: [{
                        type: "account_link",
                        url: SERVER_URL + "/authorize"
                    }]
                }
            }
        }
    };

    callSendAPI(messageData);
}


/**
 * Get started
 */
function sendGetStarted(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        get_started: {
            payload: "GET_STARTED_PAYLOAD"
        }
    };

    callSendAPI(messageData);
}
/**
 * 
 * @param {*call persistent menu} messageData 
 */
function sendPersistentMenu(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        persistent_menu: [{
                locale: "default",
                composer_input_disabled: true,
                call_to_actions: [{
                        title: "My Account",
                        type: "nested",
                        call_to_actions: [{
                                title: "Pay Bill",
                                type: "postback",
                                payload: "PAYBILL_PAYLOAD"
                            },
                            {
                                title: "History",
                                type: "postback",
                                payload: "HISTORY_PAYLOAD"
                            },
                            {
                                title: "Contact Info",
                                type: "postback",
                                payload: "CONTACT_INFO_PAYLOAD"
                            }
                        ]
                    },
                    {
                        type: "web_url",
                        title: "Latest News",
                        url: "http://petershats.parseapp.com/hat-news",
                        webview_height_ratio: "compact"
                    }
                ]
            },
            {
                locale: "zh_CN",
                composer_input_disabled: false
            }
        ]
    };

    callSendAPI(messageData);
}


function getAllLocation(latitude, longitude) {
    var options = {
        method: 'GET',
        url: 'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
        qs: {
            location: latitude + ',' + longitude,
            radius: '5000',
            types: 'atm',
            sensor: 'false',
            key: 'AIzaSyDfxCKlNXlyTUdDS_1gWYQAS2zH7pE1qgk'
        },
        headers: {
            'postman-token': 'fe437e17-b8fd-90d1-8115-00342a3b69c2',
            'cache-control': 'no-cache'
        }
    };

    request(options, function(error, response, body) {
        if (error) throw new Error(error);
        console.log(body);
        return body;
    });

}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
    request({
        uri: 'https://graph.facebook.com/v2.6/me/messages',
        qs: { access_token: FB_PAGE_ACCESS_TOKEN },
        method: 'POST',
        json: messageData

    }, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var recipientId = body.recipient_id;
            var messageId = body.message_id;

            if (messageId) {
                console.log("Successfully sent message with id %s to recipient %s",
                    messageId, recipientId);
            } else {
                console.log("Successfully called Send API for recipient %s",
                    recipientId);
            }
        } else {
            console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
        }
    });
}

app.listen(REST_PORT, () => {
    console.log('Rest service ready on port ' + REST_PORT);
});

facebookBot.doSubscribeRequest();