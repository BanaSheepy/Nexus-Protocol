# Nexus Protocol
Nexus Protocol | An Ubuntu CLI messaging server and client!

## Ubuntu Server install Guide

### Add NodeSource repository for latest Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -

### Install Node.js and build tools
sudo apt update
sudo apt install -y nodejs build-essential

### Install Yarn
sudo npm install -g yarn

### Directory!!
mkdir -p ~/nexus
cd ~/nexus

### Package
yarn init -y

### More important stuff
yarn add sqlite3 cbor ws

### Final Setup
yarn install # To get all the stuff listed in package.json
and finally:
yarn start # To start the Server

// The setup above is using stuff I did for the EARLY VERSIONS, but it still uses all the same stuff
they may be problems with the setup, if this is the case let me know.
Make sure you are running sudo before each install thing.

## Ubuntu Client
Just install our latest cli.js release and type
node cli.js

# IMPORTANT NOTICE
I spent all night building this. It's gonna be buggy as hell, please post in issues.
I made this with the intentions of people working on it and releasing their own variants so I'd love to be sent them if you do!
They is no update function so if I make more releases you can't update and migrate to the latest version.
I will try to make that though<3

# Windows
I wanna port this to windows put I can't be bothered..
