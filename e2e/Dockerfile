FROM node:20-bookworm-slim

RUN apt-get -y update \
    && apt-get -y install python3 make g++ \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /srv/test

COPY package.json ./
RUN npm install

COPY test.js ./

CMD ["node", "test.js"]
