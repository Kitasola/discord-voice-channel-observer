// Sleep
const http = require("http");
http
  .createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Discord bot is active now. Timestamp = " + Date.now());
  })
  .listen(process.env.PORT || 5000);

require('dotenv').config()

// Discord bot implements
const discord = require("discord.js");
const client = new discord.Client();

// Initialize Bot
client.on("ready", () => {
  client.user.setPresence({
    status: "online",
    activity: { name: "Voice Channel", type: "WATCHING" }
  });
  console.log("Bot is ready.");
});

// Initialize Database
const MongoClient = new require('mongodb').MongoClient(process.env.MONGODB_URI, { useUnifiedTopology: true });
let observeChannels, guildSettings, observeMembers;
MongoClient.connect((err) => {
  if (err) throw err;
  const db = MongoClient.db();
  observeChannels = db.collection("observeChannels");
  guildSettings = db.collection("guildSettings");
  observeMembers = db.collection("observeMembers");
  console.log("Database is ready.");
});

async function initDatabase(guild) {
  await deleteDatabase(guild);

  const time = new Date();
  const voiceChannels = new Array();
  await guild.channels.cache
    .filter(channel => channel.type == "voice" && channel.id != guild.afkChannelID)
    .forEach(async (channel) => {
      voiceChannels.push({ name: channel.name, id: channel.id, calling: false, time: time });
    });
  await observeChannels.insertMany(voiceChannels);

  guildSettings.insertOne({ id: guild.id, minTime: defaultMinTime });
  createChannelList(guild);
}

async function deleteDatabase(guild) {
  guildSettings.deleteMany({ id: guild.id });
  observeChannels.deleteMany({ id: { $in: guild.channels.cache.keyArray() } });
  observeMembers.deleteMany({ id: { $in: guild.members.cache.keyArray() } });
}

async function addObserveChannel(channel) {
  await observeChannels.updateOne(
    { id: channel.id },
    {
      name: channel.name,
      id: channel.id,
      calling: false,
      time: new Date()
    }, { upsert: true }
  );
}

function deleteObserveChannel(channel) {
  observeChannels.deleteOne({ id: channel.id });
}

// Callbuck Join/BAN Guild
client.on("guildCreate", guild => {
  initDatabase(guild);
  initLogChannel(guild.channels);
  console.log("Bot join server: " + guild.name);
});

client.on("guildDelete", guild => {
  deleteDatabase(guild);
  console.log("Bot ban server: " + guild.name);
});

function createChannelList(guild) {
  observeChannels.find({ id: { $in: guild.channels.cache.keyArray() } }).toArray((err, channels) => {
    let list = new Array();
    channels.forEach((channel) => {
      list.push(channel.name);
    });
    guildSettings.updateOne({ id: guild.id }, { $set: { list: list } });
  });
}

// Observe Voice Channel
client.on("voiceStateUpdate", async (oldState, newState) => {
  let finished = false;
  await initLogChannel(newState.guild.channels);
  // Trigger Join/Exit VC
  if (newState.channel != oldState.channel) {
    if (newState.channel != null) {
      observeChannels.find({ id: newState.channel.id }).toArray((err, channels) => {
        if (channels[0] == undefined) {
          return;
        }
        const channel = channels[0];
        if (!channel.calling) {
          observeChannels.updateMany(
            { id: channel.id },
            { $set: { calling: true, time: new Date() } }
          );
          await sendVoiceStart(newState);
          finished = true;
        }
      });
    }

    if (!finished && oldState.channel != null && oldState.channel.members.size < 1) {
      observeChannels.find({ id: oldState.channel.id }).toArray((err, channels) => {
        if (channels[0] == undefined) {
          return;
        }
        const channel = channels[0];
        if (channel.calling) {
          observeChannels.updateMany(
            { id: channel.id },
            { $set: { calling: false } },
          );
          guildSettings.find({ id: oldState.guild.id }).toArray((err, guilds) => {
            sendVoiceEnd(channel, guilds[0].minTime);
          });
          finished = true;
        }
      });
    }
  }

  // Trigger ON/OFF Stream
  if (newState.streaming != oldState.streaming) {
    if (newState.streaming) {
      observeMembers.insertOne({ id: newState.id, time: Date.now() }, { upsert: true }, () => {
        sendSteamOn(newState);
      });
    } else {
      observeMembers.find({ id: oldState.id }).toArray(async (err, members) => {
        if (members[0] != undefined) {
          await guildSettings.find({ id: oldState.guild.id }).toArray((err, guilds) => {
            sendStreamOff(oldState, members[0].time, guilds[0].minTime);
          });
          observeMembers.deleteMany({ id: oldState.id });
        }
      });
    }
  }
});

// Log Channel
let logChannel;
const logChannelName = "call";

function initLogChannel(channels) {
  logChannel = channels.cache.find(channel => channel.name == logChannelName);
  if (logChannel == undefined) {
    logChannel = channels.create(logChannelName, {
      type: "text",
      topic:
        "通話履歴を記録するためのチャンネル / This channel is recorded call history."
    });
  }
}

async function sendVoiceStart(state) {
  let message = {
    embed: {
      title: "通話開始",
      color: 8382940,
      thumbnail: {
        url:
          "https://cdn.discordapp.com/avatars/" +
          state.member.user.id +
          "/" +
          state.member.user.avatar +
          ".png"
      },
      fields: [
        {
          name: "チャンネル名",
          value: state.channel.name,
          inline: true
        },
        {
          name: "始めた人",
          value: state.member.user.username,
          inline: true
        }
      ]
    }
  };

  logChannel.send(message);
}

function sendVoiceEnd(channel, minTime) {
  let message = {
    embed: {
      title: "通話終了",
      color: 14498578,
      fields: [
        {
          name: "チャンネル名",
          value: channel.name,
          inline: true
        },
        {
          name: "通話時間",
          value: convertTimestamp(channel.time, new Date(), minTime),
          inline: true
        }
      ]
    }
  };

  if (message.embed.fields[1].value != undefined) {
    logChannel.send(message);
  }
};

function sendSteamOn(state) {
  let message = {
    embed: {
      title: "配信開始",
      color: 767011,
      thumbnail: {
        url:
          "https://cdn.discordapp.com/avatars/" +
          state.member.user.id +
          "/" +
          state.member.user.avatar +
          ".png"
      },
      fields: [
        {
          name: "チャンネル名",
          value: state.channel.name,
          inline: true
        },
        {
          name: "配信者",
          value: state.member.user.username,
          inline: true
        },
        {
          name: "配信画面",
          value: "",
          inline: true
        }
      ]
    }
  };

  let activity = state.member.presence.activities[0];
  if (activity != undefined && activity.name != undefined) {
    if (activity.url != undefined) {
      message.embed.fields[2].value = `[${activity.name}](${activity.url})`;
    } else {
      message.embed.fields[2].value = activity.name;
    }
  } else {
    message.embed.fields[2].value = "unknown";
  }

  logChannel.send(message);
};

function sendStreamOff(state, time, minTime) {
  let message = {
    embed: {
      title: "配信終了",
      color: 14498578,
      thumbnail: {
        url:
          "https://cdn.discordapp.com/avatars/" +
          state.member.user.id +
          "/" +
          state.member.user.avatar +
          ".png"
      },
      fields: [
        {
          name: "チャンネル名",
          value: state.channel.name,
          inline: true
        },
        {
          name: "配信者",
          value: state.member.user.username,
          inline: true
        },
        {
          name: "配信時間",
          value: convertTimestamp(time, Date.now(), minTime),
          inline: true
        }
      ]
    }
  };

  if (message.embed.fields[2].value != undefined) {
    logChannel.send(message);
  }
}

// Convert Timestamp Difference
let defaultMinTime = 30;
function convertTimestamp(start, end, minTime) {
  if (minTime == undefined) {
    minTime = defaultMinTime;
  }
  if (end - start < minTime * 1000) {
    return undefined;
  }
  const hour = ("00" + parseInt((end - start) / 1000 / 60 / 60)).slice(-2);
  const min = ("00" + parseInt(((end - start) / 1000 / 60) % 60)).slice(-2);
  const sec = ("00" + parseInt(((end - start) / 1000) % 60)).slice(-2);
  return hour + ":" + min + ":" + sec;
}

function changeMinTime(time, guild) {
  if (time < 0) {
    time = 0;
  }
  guildSettings.updateMany(
    { id: guild.id },
    { $set: { minTime: time } },
  );
}

// Command
let sendMessage;
client.on("message", async message => {
  if (message.author.bot) {
    return;
  }

  if (message.mentions.users.find(user => user == client.user) != undefined) {
    sendMessage = "にゃーん\n";
    const command = message.content.split(" ");
    switch (command[1]) {
      case "ignore":
        if (parseInt(command[2]) != NaN) {
          changeMinTime(parseInt(command[2]), message.guild);
        } else {
          sendMessage += "Failed command"
        }
        break;
      case "add":
        if (command[2] != undefined) {
          addObserveChannel(message.guild.channels.cache.get(command[2]));
          createChannelList(message.guild);
        } else {
          sendMessage += "Failed command"
        }
        break;
      case "delete":
        if (command[2] != undefined) {
          deleteObserveChannel(message.guild.channels.cache.get(command[2]));
          createChannelList(message.guild);
        } else {
          sendMessage += "Failed command"
        }
        break;
      case "reload":
        initDatabase(message.guild);
        break;
      case "list":
        sendMessage += '監視しているVoice Channel';
        sendMessage += '```';
        guildSettings.find({ id: message.guild.id }).toArray(async (err, guild) => {
          await guild[0].list.forEach(name => {
            sendMessage += name + '\n';
          });
          sendMessage += '```';
          message.reply(sendMessage);
        });
        return;
        break;
      case "help":
      default:
        sendMessage += createHelpMessage();
        break;
    }
    message.reply(sendMessage);
    return;
  }
});

function createHelpMessage() {
  let message = `各コマンドの先頭には${client.user}が必要です.\n`;
  message += "```\n";
  message += "reload\n";
  message += "各種設定や通話履歴の初期化をする.\n\n";
  message += "ignore [time]\n";
  message +=
    "time秒未満で通話が終了した場合通知しないようにする(デフォルト30秒). time: 整数(0以下は全て0になる)\n\n";
  message += "list\n";
  message += "Botが監視するVoice Channelのリストを表示する.\n\n";
  message += "add [id]\n";
  message +=
    "Botが監視するVoice Channelのリストにidのチャンネルを追加する. name: チャンネルID\n\n";
  message += "delete [id]\n";
  message +=
    "Botが監視するVoice Channelのリストからidのチャンネルを削除する. name: チャンネルID\n\n";
  message += "```\n";
  message += "powered by herokua\n";
  return message;
}

// Error
if (process.env.DISCORD_BOT_TOKEN == undefined) {
  console.log("please set ENV: DISCORD_BOT_TOKEN");
  process.exit(0);
}

client.login(process.env.DISCORD_BOT_TOKEN);