import { Box, Text, useApp, useInput, useStdin } from "ink";
import type { Result } from "meow";
import type { FC } from "react";
import React, { useCallback, useState } from "react";

import { CLI_VERSION } from "../utils/version.js";
import Auth from "./commands/Auth.js";
import Cache from "./commands/Cache.js";
import Chat from "./commands/Chat.js";
import Conversations from "./commands/Conversations.js";
import Logout from "./commands/Logout.js";
import NonInteractiveChat from "./commands/NonInteractiveChat.js";
import SkillInit from "./commands/SkillInit.js";
import Status from "./commands/Status.js";
import UpdateInfo from "./components/UpdateInfo.js";
import Help from "./Help.js";

interface AppProps {
  cli: Result<{
    version: {
      type: "boolean";
      shortFlag: "v";
    };
    force: {
      type: "boolean";
      shortFlag: "f";
    };
    help: {
      type: "boolean";
      shortFlag: "h";
    };
    port: {
      type: "number";
      shortFlag: "p";
    };
    sId: {
      type: "string";
      shortFlag: "s";
      isMultiple: true;
    };
    agent: {
      type: "string";
      shortFlag: "a";
    };
    message: {
      type: "string";
      shortFlag: "m";
    };
    conversationId: {
      type: "string";
      shortFlag: "c";
    };
    messageId: {
      type: "string";
    };
    details: {
      type: "boolean";
      shortFlag: "d";
    };
    auto: {
      type: "boolean";
    };
    noUpdateCheck: {
      type: "boolean";
    };
    key: {
      type: "string";
    };
    workspaceId: {
      type: "string";
    };
    resume: {
      type: "string";
      shortFlag: "r";
    };
    projectName: {
      type: "string";
    };
    projectId: {
      type: "string";
    };
    withTools: {
      type: "boolean";
    };
    plan: {
      type: "boolean";
    };
    loop: {
      type: "string";
    };
    maxRuns: {
      type: "number";
    };
    loopFreshConversation: {
      type: "boolean";
    };
  }>;
}

const App: FC<AppProps> = ({ cli }) => {
  const [updateCheckComplete, setUpdateCheckComplete] = useState(false);
  const { input, flags } = cli;
  const command = input[0] || "chat";
  const isNonInteractiveChat =
    command === "chat" && Boolean(flags.message || flags.messageId);
  const isInteractiveChat = command === "chat" && !isNonInteractiveChat;

  const handleUpdateComplete = useCallback(() => {
    setUpdateCheckComplete(true);
  }, []);

  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  // Immediate exit-on-Ctrl+C for every screen except the interactive chat,
  // which implements its own safer (confirm-to-exit / cancel-generation)
  // handling in Chat.tsx instead of a single accidental keypress ending
  // the whole session. Guarded by isRawModeSupported: useInput
  // unconditionally requires raw-mode-capable stdin when active, which
  // isn't available when stdin is piped/redirected (e.g. non-interactive
  // invocations) — without this guard, those would crash instead of just
  // not having a Ctrl+C shortcut.
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        exit();
      }
    },
    { isActive: !isInteractiveChat && Boolean(isRawModeSupported) }
  );

  if (flags.version) {
    return <Text>Dust CLI v{CLI_VERSION}</Text>;
  }

  if (flags.help) {
    return <Help />;
  }

  // --loop only exists on the non-interactive path, which is selected by
  // --message. Caught here rather than inside NonInteractiveChat because
  // without --message that component never mounts: the flags would be
  // silently ignored and an interactive chat would open instead, leaving the
  // user to wonder why nothing looped. (Interactive looping is /loop.)
  if (flags.loop !== undefined && !flags.message) {
    return (
      <Text color="red">
        Error: --loop requires --message. Inside an interactive chat, use /loop
        instead.
      </Text>
    );
  }

  // The mirror image of the check above: plan mode is interactive-only,
  // because approving a plan needs someone to approve it. Rejected loudly
  // rather than ignored - a user who passes --plan expecting nothing to be
  // written would otherwise get a run that writes freely.
  if (flags.plan && (flags.message || flags.messageId)) {
    return (
      <Text color="red">
        Error: --plan cannot be used with --message. Plan mode needs an
        interactive session, because approving a plan requires you to approve
        it.
      </Text>
    );
  }

  // Skip update checks for non-interactive chat mode.
  if (!flags.noUpdateCheck && !isNonInteractiveChat && !updateCheckComplete) {
    return <UpdateInfo onComplete={handleUpdateComplete} />;
  }

  // Handle --resume flag: treat as chat with conversationId
  const resumeId = flags.resume;
  const effectiveConversationId = resumeId || flags.conversationId;

  switch (command) {
    case "login":
      return (
        <Auth force={flags.force} apiKey={flags.key} wId={flags.workspaceId} />
      );
    case "status":
      return <Status />;
    case "logout":
      return <Logout />;
    case "conversations":
      return <Conversations />;
    case "chat":
      // Check if this is a non-interactive chat operation
      if (flags.message || flags.messageId) {
        return (
          <NonInteractiveChat
            agentSearch={flags.agent}
            message={flags.message}
            conversationId={flags.conversationId}
            messageId={flags.messageId}
            details={flags.details}
            projectName={flags.projectName}
            projectId={flags.projectId}
            withTools={flags.withTools}
            loop={flags.loop}
            maxRuns={flags.maxRuns}
            loopFreshConversation={flags.loopFreshConversation}
          />
        );
      }
      // Interactive chat
      return (
        <Chat
          sId={flags.sId?.[0]}
          agentSearch={flags.agent}
          conversationId={effectiveConversationId}
          autoAcceptEditsFlag={flags.auto}
          planModeFlag={flags.plan}
          projectName={flags.projectName}
          projectId={flags.projectId}
        />
      );
    case "skill:init":
      return <SkillInit />;
    case "cache:clear":
      return <Cache />;
    case "help":
      return <Help />;
    default:
      return (
        <Box flexDirection="column">
          <Text color="red">Unknown command: {command}</Text>
          <Box marginTop={1}>
            <Help />
          </Box>
        </Box>
      );
  }
};

export default App;
