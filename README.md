# Delegatto

Delegatto is a Windows desktop app for Claude Code, laid out like a chat app. Every project you've worked on gets a place in one list, you can scroll back through every conversation, and you can keep chatting with Claude without opening a terminal.

![Delegatto with a project's chat open: the project list on the left, the conversation in the middle, and Claude running four subagents in the background](.github/assets/screenshot.jpg)

> Delegatto is an independent, unofficial project with no connection to Anthropic. Anthropic doesn't make, sponsor, endorse, or support it. Claude and Claude Code are trademarks of Anthropic.

## Getting started

1. Install [Claude Code](https://docs.claude.com/en/docs/claude-code) and sign in. Delegatto runs your chats through it, so they count toward your own plan or API key.
2. Download Delegatto from the [Releases page](https://github.com/niftiest/Delegatto/releases). There are two versions:
   - Delegatto-Setup installs the app and keeps it up to date automatically.
   - Delegatto-Portable is a single file you can run from anywhere, with nothing to install. It updates itself.
3. Open it, and your projects and chats appear on their own.

Delegatto runs on Windows 10 and 11. If Claude Code is missing, the empty chat list says so and links to the install guide. Chats from claude.ai or the Claude desktop app aren't stored on your PC, so they won't appear.

> The first time you run it, Windows may say "Windows protected your PC" because Delegatto isn't signed with a certificate yet. Click **More info**, then **Run anyway**.

## Finding your way around

Projects show up on their own, sorted into Today, Yesterday, This week and so on, with the latest message under each name. You can favorite them, sort them into your own groups, rename them, give them icons or pictures, and hide the ones you don't need. A compact view fits about twice as many on screen. An empty project leaves the list unless you've favorited it, named it, or given it an icon.

Projects with new activity are highlighted, and day dividers break up long chats. Ctrl+K searches every conversation you've ever had, and Ctrl+F searches the open project. Clicking a result goes to that message and scrolls the project into the middle of the list.

A project with two or more chats shows them in a session list beside the chat, where you can right-click one to delete it. Each project opens on its newest chat.

On a big screen, the split view puts two, three or four chats side by side in their own window. Pick a layout from the icon in the chat header, and the chat you're in becomes the first pane, then choose a project for each of the others. Each pane is a full working chat. You can drag the dividers, drag a pane by its name to swap it with another, close one and pick a different project, or switch layouts. Ctrl+1 to Ctrl+4 move between panes. The split window minimizes and maximizes on its own, and it comes back after a restart.

If a project's folder is moved or deleted, the project goes to an Archived section and its chats stay readable. Its favorite, name, and icon follow it if it has an obvious new home.

## Chatting with Claude

Pick up any conversation where you left off, or start a new one in any folder. If the GitHub CLI (`gh`) is installed and signed in, New chat also lists your GitHub repositories, with a filter once there are more than 10. Picking one that isn't on this PC clones it first. Projects linked to GitHub show a GitHub icon.

Each project remembers its model, effort, and permissions. The model lists come straight from Claude Code, and you can change the mode or model while Claude is working. Shift+Tab switches modes, as it does in the terminal.

Replies appear as Claude writes them, including its thinking text and each subagent's steps. A live line shows how long it's been working, the tokens used, and the current tool. Tool calls collapse into one line you can expand, or you can show them all. Settings sets whether tool calls and Claude's thoughts show, and each project can switch either off or on in its Project options. Consecutive thoughts group into one collapsed item.

While Claude is busy, you can keep typing and your messages wait in line. Esc stops Claude, or takes back a message it hasn't answered yet so you can edit it. With a message queued, Esc returns the newest one to the box without stopping Claude, and pressing Esc twice clears the box. Up, Down, and Ctrl+R bring back what you've typed.

You can paste or drop images into the message box, and they show as thumbnails you can click to enlarge. Replies format tables, bold, bullets, headings, links, and code blocks, with syntax colors and a copy button on code.

Other things you can do in a chat:

- Rewind to an earlier message, or pin a message to find it again later.
- Type `/` to list every skill and command Claude has for that project, including plugins, or `@` to find project files to mention.
- Use `/compact`, `/context`, `/usage`, and other commands right in the chat. `/clear` starts a new chat in the same folder, `/fork` copies a chat so you can take it another way, `/rename` names it, and `/btw` asks a side question without touching the chat. Terminal commands that Delegatto has its own screen for open it: `/memory`, `/skills`, `/permissions`, `/theme`, `/mcp`, `/resume`, `/config`, `/hooks` (see, add and remove hooks), `/diff` (what changed, file by file), `/tasks` (background tasks, with their output and a stop button), `/export` (copy the chat or save it as text) and `/plugin` (install, turn on or off, update and remove plugins and marketplaces). `/status`, `/usage`, `/copy`, `/plan`, `/focus`, `/model` and `/effort` work here too, and the `/` menu lists them all. Commands that only work in Claude Code's terminal, such as `/login` or `/ide`, offer to open the chat in one.
- Start a message with `!` to run a shell command in the chat's folder, as you would in the terminal.
- Use `/add-dir` or Project options to add other folders to a project.
- Open a background task's output, or a subagent's full transcript.
- Right-click text to copy it or a link, and fix misspelled words from the Windows spell checker.
- Turn on next-prompt suggestions, which offer a guess at your next message as a chip you can click. They're off by default. Turn them on in Settings, or for one project in its Project options.

## Staying in control

When Claude asks for permission, wants to run a plan past you, or has a question, you get a card to answer with a click. If another chat is waiting on you, a banner tells you which one. When Claude wants to reach a folder outside the project, you can choose Allow for this session, Always allow, or Deny.

Before a new chat starts in a folder Claude has never worked in, Delegatto asks whether you trust it and names the hooks, MCP servers, and settings it would pick up. It follows Claude Code's rules, so a folder inside a git repository is trusted with the whole repository, and your answer also stops a terminal there from asking again. If a chat's MCP server fails or needs a sign-in, the header shows a warning with the reason and a Reconnect or Sign in button. Typing `/mcp` lists the chat's servers with Reconnect, Sign in, and Turn off or on for each, and `/mcp reconnect`, `/mcp enable` and `/mcp disable` work as they do in the terminal. The app also warns you if Claude Code can't save a chat, and a message blocked by a hook comes back to the box.

Each chat and the whole app show a running cost, and you can set a spending cap. The chat list footer shows your plan usage, or the current chat's tokens and cost if you aren't on a subscription. A context bar shows how much room a chat has left, with a Compact button for when it fills up.

Desktop notifications tell you when Claude finishes, needs permission, or has a question, with Do not disturb and quiet hours available. There's no limit on running chats. Idle ones close after 10 minutes, a time you can change, and pick up where they were on your next message. A chat that's working is never closed.

## Working alongside the terminal

You can keep using Claude in a terminal whenever you like. Delegatto notices, moves that chat to the top, and shows new messages as they arrive.

While a terminal has a chat open, it's read-only in Delegatto so two windows can't talk over each other, and it unlocks by itself when the terminal closes. "Hijack conversation" closes Claude in that terminal and unlocks the chat here, but it only works while Claude is waiting for you, never in the middle of work.

Chats you've opened for remote control from your phone or the web get a small badge. A panel lists every Claude process Delegatto has open and lets you stop one, and another shows your background tasks.

## Syncing between your PCs

Project sync keeps the chats in the projects you choose the same across your PCs, through a private GitHub repo you own. Turn it on by right-clicking a project in the chat list, in a chat's Project options, or when you create a new chat, and Settings lists what's syncing with a toggle for each. It uses your GitHub CLI sign-in and encrypts everything before upload by default. Each project gets checked for likely keys and passwords before it syncs, so you can redact them, leave those chats out, or sync anyway. The check can miss things, such as a key in a picture.

Only chats sync, so your code stays with the project's own repo. On a second PC, Delegatto finds your sync repo and asks for your recovery key once. Keep that key safe: a new PC can't read the synced copy without it. Projects from your other PCs then appear in the chat list's notice, in Settings, and with a sync icon in New chat. Projects that are syncing show the same icon in the chat list. Setting one up clones its repo into the folder you choose and brings its chats over.

## Cleaning up your history

Claude Code keeps a lot of data over time, and the Manage screen shows you all of it. It lists every project with its size, its chat count, and when you last used it, and it can search through names, chats, and Claude's memory.

Deleting a chat or a project goes step by step. Delegatto closes anything still using it, offers to save a backup, shows exactly what will be removed, and sends it to the Recycle Bin. Your actual project files are never touched, and a backup made before a delete lets you undo it.

From the same screen you can:

- Save projects to a backup file and restore them at any time.
- Move or rename a project folder and keep its chats, memory, and settings.
- Find the notes, plans, and docs inside your projects, preview them, and open them in your editor.
- Close Claude sessions that are still running.

Claude Code deletes chats after 30 days unless you change that setting. Delegatto shows you the setting, warns you if a project shortens it, and lets you change it with a click. You can also have old chats in some projects move to the Recycle Bin after a while and keep others forever.

## Making it yours

There are six built-in themes: Paper, a light theme and the default, four dark ones (Slate & Teal, Ember, Plum & Rose, and Forest), and Terminal, which looks like Claude Code in a terminal and can cover just the chat or the whole app. Each theme comes with its own font, included with the app. You can save your appearance settings as a named theme, including your font, and import or export themes as files. If a PC doesn't have a theme's font, the default is used.

You can also keep themes of your own on one PC. Put a `.css` file in the themes folder (Settings, Appearance, Open themes folder), and it appears in the theme list under its file name. It can set the theme's colors and style any part of the window, and it never leaves that PC. Import also takes a `.css` file and copies it into that folder for you.

Text size is separate for the chat and the sidebars, and holding Ctrl while using the mouse wheel over a chat changes it there. The font list comes from your PC, and code stays monospaced.

Claude's avatar can be an emoji, a color, or a picture. With your own image-service key, you can also create one with AI, or create images for a project and save them into its folder.

Right-click a project to open its folder, or to view and edit its `CLAUDE.md` and Claude's auto-memory notes. Running chats pick up those changes on their next message. Settings let you browse the skills and commands Claude has available, and check how each of your MCP servers is doing.

Settings also cover Claude Code's own options, for all projects or just one: default model and effort, what Claude may do without asking, whether commits credit Claude, memory, and more. You can edit the settings file directly too. Changes apply in the terminal as well.

Delegatto can start with Windows and live in the system tray. The first time you close the window, it asks whether to exit or minimize to the tray, and remembers your answer. It checks for updates every hour, but downloads a new version only when you click Download, and asks before restarting if a chat is working or something is unsent. After an update, it reopens the chat you were in.

## Your data

Delegatto has no account, no tracking, and no server of its own. It goes online to check for new versions of itself, and Claude Code talks to Anthropic as it normally does. It reaches anything else only if you use the feature: GitHub through your `gh` sign-in for repositories and project sync, and an image service through your own key for the AI image features.

## For developers

Delegatto is open source. To run it from source, you'll need Node.js 22 or newer:

```
npm install
npm run dev
```

## License

[MIT](LICENSE)
