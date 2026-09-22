# Generated Project

A fully functional project with the required schema and features present on byldd's boilerplate.

## How to Install and Run the Project

Install the required node_modules

```bash
  npm i
```

Generated project needs firebase emulator for develeopment and staging environment.

Follow these steps if firebase tools is not installed on your local.

```bash
  npm install -g firebase-tools
```

Login with cli to check whether it is installed properly.

```bash
  firebase login:ci
```

Also you need to have ["Java Development Kit"](https://www.oracle.com/java/technologies/downloads/) installed on your system to use firebase firestore emulator.

```bash
  Make sure to restart your system after installing "Java Development Kit"
```

You will need to enable auth providers to use authentication on generated project.

Head over to firebase project console and go to authentication section and enable all the auth providers you are going to use.

![firebase auth provider](https://res.cloudinary.com/dhdv5nqpb/image/upload/v1641795565/Project%20generator%20documentation%20assets/l3p5cxl60owdsutbz32q.png)

### Add .env

```bash

DB_PATH=[mongo uri]
STRIPE_SECRET_KEY=[required only if you want to use stripe service]
STRIPE_WEBHOOK_SECRET=[required only if you want to use stripe service]
SENDGRID_API_KEY=[required only if you want to send emails]
SENDGRID_USER_EMAIL=[required only if you want to send emails]
SENDGRID_TEST_EMAIL=[developer email for develeopment environment]
CLIENT_EMAIL=[client email]
CONTACT_FORM_TARGET=[contact form target]
MAILCHIMP_KEY=[mailchimp key]
MAILCHIMP_LIST_ID=[mailchimp list id]
IAM_USER_KEY=[s3 user key]
IAM_USER_SECRET=[s3 user secret]
BUCKET_NAME=[s3 bucket name]
NODE_ENV=[dev/production/staging]
S3_BUCKET_REGION=[s3 bucket region]
S3_BUCKET_NAME=[s3 bucket name]
S3_USER_KEY=[s3 user key]
S3_USER_SECRET=[s3 user secret]
AWS_LOG_GROUP_NAME=[aws log grop name eg. production]
PORT=8000
CRON_PORT=8001
HOST=localhost:8000
GOOGLE_VERIFY_OAUTH_URL=https://www.googleapis.com/oauth2/v3/userinfo
FACEBOOK_VERIFY_OAUTH_URL=https://graph.facebook.com/me
MICROSOFT_VERIFY_OAUTH_URL=https://graph.microsoft.com/v1.0/me
JW_API_KEY=[jw api key]
JW_API_SECRET=[jw api secret]
FIREBASE_ADMIN_TYPE=[should be filled already]
FIREBASE_ADMIN_PROJECT_ID=[should be filled already]
FIREBASE_ADMIN_PRIVATE_KEY_ID=[should be filled already]
FIREBASE_ADMIN_CLIENT_EMAIL=[should be filled already]
FIREBASE_ADMIN_CLIENT_ID=[should be filled already]
FIREBASE_ADMIN_AUTH_URI=[should be filled already]
FIREBASE_ADMIN_TOKEN_URI=[should be filled already]
FIREBASE_ADMIN_AUTH_PROVIDER_X509_CERT_URL=[should be filled already]
FIREBASE_ADMIN_CLIENT_X509_CERT_URL=[should be filled already]
FIREBASE_ADMIN_PRIVATE_KEY=[should be filled already]
FIREBASE_USER_API_KEY=[should be filled already]
FIREBASE_USER_MESSAGING_SENDER_ID=[should be filled already]
FIREBASE_USER_APP_ID=[should be filled already]
FIREBASE_EMULATOR_AUTH_PORT=4000
APPLE_CLIENT_ID=[apple cliend id web]
APPLE_CLIENT_ID_IOS=[apple client id ios]
TWILIO_NUMBER=[twilio number]
TWILIO_ACCOUNTSID=[twilio account sid]
TWILIO_AUTHTOKEN=[twilio auth token]
TWILIO_VERIFY_SERVICE_SID=[twilio auth token]
BACKUP_PATH=[db backup path for cron]
LOCAL_DB_FILE=[backup file]
SLACK_WEBHOOK_FOR_LOGS=[follow the steps mentioned in slack incoming webhook url section to get the webhook url]

```

### Compile project

Build and start the project: Local

```bash
 npm run front
 npm run tsc
 npm run server
```

Build and start the project: Staging

```bash
 npm run staging-build
 npm run tsc
 npm run server
```

Build and start the project: Production

```bash
 npm run build
 npm run tsc
 npm run server
```

Note:

```bash
 - Use 'npm run tsc-watch' for transpiling backend in watch mode
 - Use 'npm run run windows-server' insted of 'npm run server' if running on windows system
```

Build the backend: watch mode

```bash
 npm run tsc-watch
```

Start the server: For windows

```bash
 npm run windows-server
```

Start the server: For Linux

```bash
 npm run server
```

Server should be running on the specified port in .env

### Firebase emulator

Firebase emulator ui port is hard coded to 4001
Open http://localhost:4001/ in your browser to access emulator ui.

We are only using emulator for auth.

To access the authentication emulator, click 'go to emulator' button on authentication emulator card

![auth emulator](https://res.cloudinary.com/dhdv5nqpb/image/upload/v1641886423/Project%20generator%20documentation%20assets/zmav83nyofcmw0gdjl3r.png)

You can now use the firebase authentication emulator to perform the tasks that you would do on the firebase console.

![firebase auth emulator](https://res.cloudinary.com/dhdv5nqpb/image/upload/v1641886661/Project%20generator%20documentation%20assets/tkowj369vawyqmqfykte.png)

### Database seeding

For database seeding make sure:

â†’ MonoDB database tools are installed on your system. [More Info](https://docs.mongodb.com/database-tools/)

â†’ You have bash terminal installed ( All the below commands will work in a bash terminal ). [More Info](https://git-scm.com/downloads)

To change the congiguration like "connection string" or "db name" have a look at two places:

```
Scripts: {project_path}/bash-scripts
Secrets: {project_path}/secrets
```

##### Database seeding options that are already implemented are:

- Copy Local DB
  ```
  Windows: npm run copy-local-db-win
  Linux: npm run copy-local-db
  ```
- Copy Staging DB

  ```
  Windows: npm run copy-staging-db-win
  Linux: npm run copy-staging-db
  ```

- Copy Production DB

  ```
  Windows: npm run copy-prod-db-win
  Linux: npm run copy-prod-db
  ```

- Sedd Production DB

  ```
  Windows: npm run seed-prod-db-win
  Linux: npm run seed-prod-db
  ```

- Seed Staging DB

  ```
  Windows: npm run seed-staging-db-win
  Linux: npm run seed-staging-db
  ```

- Seed Local From Staging

  ```
  Windows: npm run seed-local-from-staging-win
  Linux: npm run seed-local-from-staging
  ```

- Seed Local From Staging
  ```
  Windows: npm run seed-local-from-prod-win
  Linux: npm run seed-local-from-production
  ```

### Running Test Cases

Note: Before running any testcases make sure:

â†’ You are not connceted to production db.

â†’ Stripe test keys are updated in .env.spec

â†’ Project server is not running.

Run test cases: Windows

```
npm run server-test-win
```

Run test cases: Linux

```
npm run server-test
```

### Adding mock data

Configure the mock-data-gen-config.json present in root of the project.

```
{
    "feilds": [
        {
            "schema": "Company",       // add schema name
            "count": 15,               // number of documnets needed
            "staticFeilds": {
                "userId": "61d5295b00cf1c2a000f46bf"   // add static feilds with values in staticFeilds object
            }
        },
        {
            "schema": "Chat",
            "count": 10,
            "staticFeilds": {

            }
        }
    ]
}
```

Make sure to add 'mockName' in schema feilds, refer to [package documentation](https://www.npmjs.com/package/casual) to get mock names.

Example:

```
const CompanySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      mockName: 'name' // example
    },
    userId: {
      type: ObjectId,
      ref: 'User',
      required: false,
    },
    status: {
      type: String,
      enum: [ 'Active', 'InActive' ],
      default: 'Active',
    },
    website: {
      type: String,
      required: false,
      mockName: 'url' // example
    }
  },
  { timestamps: true }
);
```

Command to add mock data:

```
npm run add-mock-data
```

Confirm that you are connected to correct db by enetering 'y' and press 'Enter'.
Mock data will be added.

### Create slack incoming webhook url

Head over to slack and to go to apps section.

Now serch for 'Incoming webhook'.

Click 'Add', this will take you to slack store.
![add incoming webhook to app](https://res.cloudinary.com/dhdv5nqpb/image/upload/v1645159501/Project%20generator%20documentation%20assets/c3ngun4mpfl7yc1jc0qj.png)

Click 'Add to slack'
![add to slack](https://res.cloudinary.com/dhdv5nqpb/image/upload/v1645159644/Project%20generator%20documentation%20assets/pxctu2aermhzijinwpwv.png)

Select the channel where you want to receive the messages.
![select channel](https://res.cloudinary.com/dhdv5nqpb/image/upload/v1645159839/Project%20generator%20documentation%20assets/nomoftabritwm4xdlxsl.png)

You will now get the webhook url, copy and paste it in your .env.
![webhook url](https://res.cloudinary.com/dhdv5nqpb/image/upload/v1645160169/Project%20generator%20documentation%20assets/gvh3ljw6ubzr0m5cvacn.png)

You can also change the webhook settings from that page itself if required.

# How To Test With Docker (Installation + Testing)

1. Install Docker desktop in your system :

   Windows installation :->
   1. To install docker desktop for windows , click on the following link :
      https://docs.docker.com/desktop/install/windows-install/

   2. To verify that Docker is running correctly, open a command prompt and run the command
      "docker run hello-world". This should download and run a test image, which should display a message indicating that the installation was successful.

      !Note: Run the docker desktop setup file only when you complete your "Linux kernal update package installation".

   3. After docker installation , download Linux kernal update package.
      (Steps to install Linux kernal update package is mentioned in the above link.)
      Recommended installation : -> ' WSL2 Backend '.
      To check the Window's version : -> Press windows button + R key and type "winver".

   4. Enable the following features in windows features section :->
      1. search 'windows features' on your system , and then enable "Virtual Machine Platform" and "Windows Subsystem for Linux".

      !Note :-> Check your system requirements for "WSL 2 Backend" in the System requirements section on the above link.

   5. After that, install WSL environment from Microsoft store :->
      https://apps.microsoft.com/store/detail/ubuntu-22041-lts/9PN20MSR04DW

   6. Once your wsl get's installed in your system, use the following command in your
      command prompt terminal : " wsl -l -v ".
      It will show you the name of your wsl environment, current version and current state.

   7. Once all the installations get's completed, restart your system.

2. Steps to run the Docker :
   1. To run the docker , you will need the Docker file.
      (Docker file is a script that contains instructions for building a Docker image)

   2. To create Docker file for node, you have to mention the following commands in the file:

      !NOTE : This will be the structure for your Docker File.

      #Each instruction in this file creates a new layer

      #Here we are getting our node as Base image
      FROM node:14-alpine

      #setting working directory in the container
      WORKDIR /usr/src/app

      #copying the package.json file(contains dependencies) from project source dir to container dir
      COPY package.json /usr/src/app

      #installing the dependencies into the container
      RUN npm install

      #copying the source code of Application into the container dir
      COPY . /usr/src/app

      #container exposed network port number
      EXPOSE 8000

      #command to run within the container
      CMD ['npm', 'run', 'tsc']
      CMD ['npm', 'run', 'server']

3. You can save the above file as "Dockerfile" in the root of your application, and you
   can build an image using this file by running this command in the root of the application:

   Command to build an image : -> " docker build -t your-image-name ".

4. For more detailed information about the installation and integration, please go
   through the following video link :->

   https://youtu.be/X3Wtjwu0vBI
