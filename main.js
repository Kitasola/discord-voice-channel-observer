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
const Datastore = require("nedb");
let observeChannels = new Datastore({
  filename: 'database/channels.db',
  autoload: 'true'
});

let guildSettings = new Datastore({
  filename: 'database/settings.db',
  autoload: 'true'
});

async function initDatabase(guild) {
  await deleteDatabase(guild);

  const time = new Date();
  guild.channels.cache
    .filter(channel => channel.type == "voice")
    .forEach(channel => {
      if (channel.id != guild.afkChannelID) {
        addObserveChannel(channel);
      }
    });

  guildSettings.insert({ id: guild.id, minTime: minTimeDiff });
  createChannelList(guild);
}

async function deleteDatabase(guild) {
  guildSettings.remove({ id: guild.id }, { multi: true });
  observeChannels.remove({ id: { $in: guild.channels.cache.keyArray() } }, { multi: true });
}

function addObserveChannel(channel) {
  observeChannels.update(
    { id: channel.id },
    {
      name: channel.name,
      id: channel.id,
      calling: false,
      time: new Date()
    }, { upsert: true }
  );
}

function removeObserveChannel(channel) {
  observeChannels.remove({ id: channel.id });
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
  observeChannels.find({ id: { $in: guild.channels.cache.keyArray() } }, (err, channels) => {
    let list = new Array();
    channels.forEach((channel) => {
      list.push(channel.name);
    });
    guildSettings.update({ id: guild.id }, { $set: { list: list } });
  });
}

// Observe Voice Channel
client.on("voiceStateUpdate", async (oldState, newState) => {
  let finished = false;
  if (newState.channel != oldState.channel) {
    await initLogChannel(newState.guild.channels);
    if (newState.channel != null) {
      observeChannels.find({ id: newState.channel.id }, (err, channels) => {
        if (channels[0] == undefined) {
          return;
        }
        const channel = channels[0];
        if (!channel.calling) {
          observeChannels.update(
            { id: channel.id },
            { $set: { calling: true, time: new Date() } },
            { multi: true }
          );
          sendVoiceStart(newState);
          finished = true;
        }
      });
    }
    if (finished) {
      return;
    }

    if (oldState.channel != null && oldState.channel.members.size < 1) {
      observeChannels.find({ id: oldState.channel.id }, (err, channels) => {
        if (channels[0] == undefined) {
          return;
        }
        const channel = channels[0];
        if (channel.calling) {
          observeChannels.update(
            { id: channel.id },
            { $set: { calling: false } },
            { multi: true }
          );
          guildSettings.find({ id: oldState.guild.id }, (err, guilds) => {
            if (guilds[0] != undefined) {
              sendVoiceEnd(channel, guilds[0].minTime);
            } else {
              sendVoiceEnd(channel, minTimeDiff);
            }
          });
          finished = true;
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

function sendVoiceStart(state) {
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

function sendVoiceEnd(channel) {
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
          value: convertTimestamp(channel.time, Date.now(), minTimeDiff),
          inline: true
        }
      ]
    }
  };

  if (message.embed.fields[1].value != undefined) {
    logChannel.send(message);
  }
}

// Convert Timestamp Difference
let minTimeDiff = 30;
function convertTimestamp(start, end, timeDiff) {
  if (end - start < timeDiff * 1000) {
    return undefined;
  }
  const hour = ("00" + parseInt((end - start) / 1000 / 60 / 60)).slice(-2);
  const min = ("00" + parseInt(((end - start) / 1000 / 60) % 60)).slice(-2);
  const sec = ("00" + parseInt(((end - start) / 1000) % 60)).slice(-2);
  return hour + ":" + min + ":" + sec;
}

function changeMinTimeDiff(time, guild) {
  if (time < 0) {
    time = 0;
  }
  guildSettings.update(
    { id: guild.id },
    { $set: { minTime: time } },
    { multi: true }
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
          changeMinTimeDiff(parseInt(command[2]), message.guild);
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
      case "remove":
        if (command[2] != undefined) {
          removeObserveChannel(message.guild.channels.cache.get(command[2]));
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
        guildSettings.find({ id: message.guild.id }, async (err, guild) => {
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
  message += "```";
  message += "reload";
  message += "各種設定や通話履歴の初期化をする.\n\n";
  message += "ignore [time]\n";
  message +=
    "time秒未満で通話が終了した場合通知しないようにする(デフォルト30秒). time: 整数(0以下は全て0になる)\n\n";
  message += "list\n";
  message += "Botが監視するVoice Channelのリストを表示する.\n\n";
  message += "add [id]\n";
  message +=
    "Botが監視するVoice Channelのリストにidのチャンネルを追加する. name: チャンネルID\n\n";
  message += "remove [id]\n";
  message +=
    "Botが監視するVoice Channelのリストからidのチャンネルを削除する. name: チャンネルID\n\n";
  message += "```";
  return message;
}

// Error
if (process.env.DISCORD_BOT_TOKEN == undefined) {
  console.log("please set ENV: DISCORD_BOT_TOKEN");
  process.exit(0);
}

client.login(process.env.DISCORD_BOT_TOKEN);