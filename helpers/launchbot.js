const launchBot = (bot) => {
  bot.telegram
    .getMe()
    .then((botInfo) => {
      console.log(`Bot ${botInfo.username} is connected and running.`);
      bot.launch({
        allowedUpdates: [
          "message",
          "edited_message",
          "callback_query",
          "chat_member", // User joins/leaves (Supergroups)
          "my_chat_member", // Bot joins/leaves or changes permissions
          "chat_join_request", // "Request to Join" link clicks
          "chat_boost", // When a premium user boosts the group
          "removed_chat_boost", // When a boost expires
          "poll",
          "poll_answer",
        ],
      });
    })
    .catch((err) => {
      console.error("Error connecting bot:", err);
      console.log("Retrying bot connection...");
      setTimeout(launchBot, 2000);
    });
};

export default launchBot;
