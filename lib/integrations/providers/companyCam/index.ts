import { UserRecord } from "firebase-admin/lib/auth/user-record";
import { UserHelper } from "../../../routes/user/helper";
import { firebaseService } from "../../../services/firebaseAdmin";
import {
  SUBSCRIPTION_STORES_ENUM,
  USER_ROLE,
} from "../../../utils/enums/enums";
import { COMPANY_CAM_USER_ROLE } from "../../../utils/enums/integrations";
import {
  FormattedTodos,
  ICompayCamUserFormatted,
  ImportResult,
  VerifyResult,
} from "../../../utils/interfaces/integrations";
import { CompanyCamClient } from "./client";
import { CompanyCamMapper } from "./mapper";
import { CompanyHelpers } from "../../../routes/company/helpers";
import { ObjectIdType } from "../../../utils/interfaces/schemaInterface";
import { ProjectHelper } from "../../../routes/projects/helper";
import { delay } from "../../../utils/helpers/commonHelper";
import { syncTagsToProject } from "../../webhookHelpers";
import { ProjectNotesHelper } from "../../../routes/projectNotes/helper";
import { FilesHelper } from "../../../routes/file/helper";
import { PostsHelper } from "../../../routes/posts/helper";
import { CommentHelper } from "../../../routes/comments/helper";
import { ChecklistHelper } from "../../../routes/checklist/helper";
import { CHECKLIST_TYPE } from "../../../utils/enums/checklist";
import { SalesforceAccountSyncService } from "../../../services/salesforceAccountSync";
import { LEAD_SOURCE } from "../../../utils/enums/salesforce";
import { EmailService } from "../../../services/email";

/**
 * Interface for creating a new user in the system
 */
interface CreateUserPayload {
  email: string;
  firebaseUid: string;
  name: { first: string; last: string };
  profileImage?: string | null;
  phone?: string;
  companyName?: string;
  roles?: USER_ROLE;
  userRole?: string;
}

export class CompanyCamImporter {
  private apiKey: string;
  private errors: string[] = [];
  private importedProjects: Map<string, string> = new Map(); // companyCamId -> crewCamId
  private client: CompanyCamClient;
  private mapper: CompanyCamMapper;

  constructor(apiKey: string, countryCode: string) {
    this.apiKey = apiKey;
    this.client = new CompanyCamClient(apiKey);
    this.mapper = new CompanyCamMapper(countryCode);
  }

  /**
   * Helper method to create a static user with default values
   */
  private async createStaticUser(params: {
    name: { first: string; last: string };
    profileImage?: string;
    userRole?: string;
    uniqueId?: string;
  }) {
    const {
      name,
      profileImage,
      userRole,
      uniqueId = Date.now().toString(),
    } = params;

    const staticUser = await UserHelper.addStaticUser({
      name,
      profileImage: profileImage || null,
      email: `static_${uniqueId}@companycam.com`,
      phone: null,
      firebaseUid: `static_${uniqueId}`,
      two_fa_secret: null,
      userRole: userRole || null,
      stripeCustomerId: null,
      stripeAccountId: null,
      defaultCardToken: null,
      renewalDate: null,
      subscribedOn: null,
      subscriptionActiveUntil: null,
      subscriptionId: null,
      referredBy: null,
      subscriptionRef: null,
      subscriptionBoughtFrom: SUBSCRIPTION_STORES_ENUM.REVENUECAT,
      subscriptionPlan: null,
      companyRef: null,
    });

    await UserHelper.clearUserDataExceptNameAndImage(staticUser._id);
    return staticUser;
  }

  /**
   * Main method to import all data from CompanyCam
   */
  async importAllData(): Promise<ImportResult> {
    // Reset errors at the start of import
    this.errors = [];

    const result: ImportResult = {
      success: false,
      projectsImported: 0,
      photosImported: 0,
      errors: [], // Will be populated from this.errors before return
      details: {
        projects: [],
      },
    };

    try {
      const usersList = await this.client.getAllUsers();

      const companyInfo = await this.client.getCompanyInfo();

      console.log({ totalUsers: usersList.length });
      let adminIndex = usersList.findIndex(
        (user) => user.user_role === COMPANY_CAM_USER_ROLE.ADMIN,
      );

      if (adminIndex === -1) {
        adminIndex = 0;
      }

      console.log({ adminIndex });

      const adminUserData = await this.mapper.mapCompanyCamUserToCrewCamUser(
        usersList[adminIndex],
        companyInfo.name,
      );

      // Check if admin already exists
      let adminUser = null;
      let company = null;
      const existingCompanyMembers: Map<string, ObjectIdType> = new Map(); // email -> userId

      // Try to find admin by email
      const adminEmail = adminUserData.email;
      let existingAdmin = null;

      if (adminEmail) {
        existingAdmin = await UserHelper.findOne({ email: adminEmail });
      }

      console.log({ existingAdmin });

      if (existingAdmin) {
        console.log("in exiting adin");
        // Admin exists, verify they are admin and use their company
        adminUser = existingAdmin;

        // Get admin's companies
        const adminCompanies = await CompanyHelpers.getMyCompanies(
          existingAdmin._id,
        );

        if (!adminCompanies || adminCompanies.length === 0) {
          throw new Error(`Admin user ${adminEmail} exists but has no company`);
        }

        // Use the first company and verify admin role
        const companyId = adminCompanies[0].companyId;

        // Check if user is actually admin in the company
        const memberRole = await CompanyHelpers.getCompanyMemberRole(
          companyId,
          existingAdmin._id,
        );

        if (memberRole?.role !== USER_ROLE.ADMIN) {
          result.success = false;
          throw new Error(
            `Admin from companyCam already exists in crewcam with a different role unable to import the data`,
          );
        }

        // Get company details
        const companyData = await CompanyHelpers.getCompanyAdminId(companyId);

        company = {
          companyId: companyId,
          name: companyData.name,
          userId: companyData.userId,
        };

        // Get all existing company members
        const companyMembers = await CompanyHelpers.getCompanyMembers([
          companyId,
        ]);

        for (const member of companyMembers) {
          const user = await UserHelper.findOne({ _id: member.userId });
          if (user && user.email) {
            existingCompanyMembers.set(user.email, user._id);
          }
        }
      } else {
        console.log("else");
        // Admin doesn't exist, create new admin and company
        adminUser = await this.registerUser(adminUserData, true);
        company = await this.createCompanyInCrewCam(
          companyInfo.name,
          adminUser._id,
        );

        SalesforceAccountSyncService.createAndLinkLead(adminUser._id, {
          FirstName: adminUserData.name.first,
          LastName: adminUserData.name.last,
          Title: adminUserData.userRole,
          Company: companyInfo.name,
          Phone: adminUserData.phone,
          Email: adminUserData.email,
          LeadSource: LEAD_SOURCE.APP_DOWNLOAD,
          Joined_On__c: new Date().toISOString(),
          RelayCam_Org_ID__c: String(company.companyId),
        });
      }

      const companyCamToCrewCamUserMap: Map<string, ObjectIdType> = new Map();
      companyCamToCrewCamUserMap.set(usersList[adminIndex].id, adminUser._id);
      companyCamToCrewCamUserMap.set("admin", adminUser._id); // Fallback mapping for admin user

      // Process other users
      await Promise.all(
        usersList.map(async (user, index) => {
          if (index === adminIndex) return adminUser;

          const mappedUserData =
            await this.mapper.mapCompanyCamUserToCrewCamUser(
              user,
              companyInfo.name,
            );

          const userEmail = mappedUserData.email;

          // Check if user already exists in the company
          if (userEmail && existingCompanyMembers.has(userEmail)) {
            // User already in company, just map them
            const existingUserId = existingCompanyMembers.get(userEmail)!;
            companyCamToCrewCamUserMap.set(user.id, existingUserId);
            return user;
          }

          // Check if user exists but not in company
          let existingUser = null;
          if (userEmail) {
            existingUser = await UserHelper.findOne({ email: userEmail });
          }

          if (existingUser) {
            // User exists but not in this company, create static user
            this.errors.push(
              `User ${userEmail} exists in another organization, creating static user`,
            );

            // Create a static user to preserve references
            const staticUser = await this.createStaticUser({
              name: mappedUserData.name,
              profileImage: mappedUserData.profileImage || undefined,
              userRole: mappedUserData.userRole,
              uniqueId: `${Date.now()}_${user.id}`,
            });

            // Map the static user
            companyCamToCrewCamUserMap.set(user.id, staticUser._id);
            return user;
          }

          // User doesn't exist, create them
          const createdUser = await this.registerUser(mappedUserData, false);

          await this.addUserToCompany(
            company.companyId,
            createdUser._id,
            user.user_role,
          );
          companyCamToCrewCamUserMap.set(user.id, createdUser._id);

          return user;
        }),
      );
      console.log("sunces users, syncing projects");

      const companyCamProjects = await this.client.getAllProjects();
      const CompanyCamProjectsToCrewcamMap: Map<string, ObjectIdType> =
        new Map();

      // Track failed projects
      const failedProjects: Array<{
        projectId: string;
        projectName: string;
        error: string;
      }> = [];
      let successfulProjects = 0;

      let i = 1;
      for await (const project of companyCamProjects) {
        //create project in crewcam
        console.log(
          "processing project",
          i++,
          "of",
          companyCamProjects.length,
          project.name,
        );

        if (project.status == "deleted") continue;

        try {
          const mappedProject =
            await this.mapper.mapCompanyCamProjectToCrewCamProject(project);

          const createdProject = await ProjectHelper.createByPayLoad({
            ...mappedProject,
            companyId: company.companyId,
            userId:
              companyCamToCrewCamUserMap.get(project.creator_id) ||
              companyCamToCrewCamUserMap.get("admin")!,
          });

          CompanyCamProjectsToCrewcamMap.set(
            project.id.toString(),
            createdProject._id,
          );

          await delay(200);
          console.log("syncing tags");
          //sync tags
          await this.syncTagsForProject(
            project.id,
            createdProject._id,
            company.companyId,
          );

          await delay(200);
          console.log("syncing notes");
          //sync project notes
          await this.syncNotesForProject(
            project.id,
            createdProject._id,
            companyCamToCrewCamUserMap,
          );

          await delay(200);

          console.log("syncing project files");
          //async project files
          await this.syncProjectFiles(
            project.id,
            createdProject._id,
            company.companyId,
            companyCamToCrewCamUserMap,
          );

          await delay(200);
          console.log("syncing projectposts");
          //sync project photos as posts
          const posts = await this.syncProjectPosts(
            project.id,
            createdProject._id,
            company.companyId,
            companyCamToCrewCamUserMap,
          );
          result.photosImported += posts;

          await delay(200);

          console.log("syncing checklists");
          //sync checklists
          await this.syncChecklistsForProject(
            project.id,
            createdProject._id,
            company.companyId,
            companyCamToCrewCamUserMap,
          );

          await delay(200);
          console.log("syncing project members");
          await this.syncProjectMembers(
            project.id,
            createdProject._id,
            companyCamToCrewCamUserMap,
          );

          await delay(200);

          // Increment successful projects counter
          successfulProjects++;
        } catch (projectError: any) {
          console.error(
            `Failed to import project ${project.name} (ID: ${project.id}):`,
            projectError,
          );

          // Track the failed project
          failedProjects.push({
            projectId: project.id,
            projectName: project.name,
            error: projectError?.message || String(projectError),
          });

          // Add to errors array
          this.errors.push(
            `Project ${project.name} (ID: ${project.id}) failed: ${projectError?.message || projectError}`,
          );

          // Continue with the next project
          continue;
        }
      }

      // Log summary of failed projects
      if (failedProjects.length > 0) {
        console.log("\n=== FAILED PROJECTS SUMMARY ===");
        console.log(`Total projects: ${companyCamProjects.length}`);
        console.log(`Successful imports: ${successfulProjects}`);
        console.log(`Failed imports: ${failedProjects.length}`);
        console.log("\nFailed Project Details:");
        failedProjects.forEach((fp, index) => {
          console.log(`${index + 1}. ${fp.projectName} (ID: ${fp.projectId})`);
          console.log(`   Error: ${fp.error}`);
        });
        console.log("================================\n");

        // Send email with failed projects report to saketh@byldd.com
        try {
          const emailService = new EmailService();
          const emailBody = `
CompanyCam Import Summary
========================
Company: ${companyInfo.name}
Admin Email: ${adminEmail || "N/A"}
Total projects: ${companyCamProjects.length}
Successful imports: ${successfulProjects}
Failed imports: ${failedProjects.length}

Failed Project Details:
-----------------------
${failedProjects
  .map(
    (fp, index) =>
      `${index + 1}. ${fp.projectName} (ID: ${fp.projectId})
   Error: ${fp.error}`,
  )
  .join("\n\n")}

================================
Import completed at: ${new Date().toISOString()}
`;

          await emailService.sendEmail({
            subject: `CompanyCam Import Report - ${failedProjects.length} Failed Projects`,
            email: "saketh@byldd.com",
            data: emailBody,
          });
          console.log(`Failed projects report sent to saketh@byldd.com`);
        } catch (emailError) {
          console.error("Failed to send email report:", emailError);
          // Don't fail the import if email fails
        }
      } else {
        console.log(
          `\n✅ All ${successfulProjects} projects synced successfully!`,
        );

        // Send success email to saketh@byldd.com
        try {
          const emailService = new EmailService();
          const emailBody = `
CompanyCam Import Summary
========================
Company: ${companyInfo.name}
Admin Email: ${adminEmail || "N/A"}
Total projects imported: ${successfulProjects}
Total photos imported: ${result.photosImported}

✅ All projects were imported successfully!

================================
Import completed at: ${new Date().toISOString()}
`;
          await emailService.sendEmail({
            subject: `CompanyCam Import Success - All ${successfulProjects} Projects Imported`,
            email: "saketh@byldd.com",
            data: emailBody,
          });
          console.log(`Success report sent to saketh@byldd.com`);
        } catch (emailError) {
          console.error("Failed to send success email:", emailError);
        }
      }

      result.projectsImported = successfulProjects;
      result.success = true;
      result.errors = [...this.errors]; // Copy all accumulated errors
      result.failedProjects = failedProjects; // Add failed projects to result

      return result;
    } catch (error) {
      this.errors.push(`Fatal error: ${error}`);
      result.errors = [...this.errors]; // Copy all accumulated errors including the fatal one
      return result;
    }
  }

  /**
   * Verify user data before import - check for existing emails and phone numbers
   */
  async verifyUserData(): Promise<VerifyResult> {
    this.errors = [];
    const result: VerifyResult = {
      success: true,
      errors: [],
    };
    try {
      const usersList = await this.client.getAllUsers();

      let adminIndex = usersList.findIndex(
        (user) => user.user_role === COMPANY_CAM_USER_ROLE.ADMIN,
      );

      if (adminIndex === -1) {
        adminIndex = 0;
      }

      // Map users to get their formatted data first
      const mappedUsers = await Promise.all(
        usersList.map(async (user) => {
          const mappedData = await this.mapper.mapCompanyCamUserToCrewCamUser(
            user,
            "temp",
          );
          return { original: user, mapped: mappedData };
        }),
      );

      // Check if admin already exists and get their company
      const existingCompanyMembers: Set<string> = new Set();
      const adminUser = mappedUsers[adminIndex];

      if (adminUser) {
        const { email: adminEmail, phone: adminPhone } = adminUser.mapped;

        // Find admin user by email or phone
        let existingAdmin = null;
        if (adminEmail) {
          existingAdmin = await UserHelper.findOne({ email: adminEmail });
        }
        if (!existingAdmin && adminPhone) {
          existingAdmin = await UserHelper.findOne({ phone: adminPhone });
        }

        // If admin exists, get their company and members
        if (existingAdmin) {
          const adminCompanies = await CompanyHelpers.getMyCompanies(
            existingAdmin._id,
          );

          if (adminCompanies && adminCompanies.length > 0) {
            // Get all company members for admin's companies
            const companyIds = adminCompanies.map((c) => c.companyId);

            const adminData = await CompanyHelpers.getCompanyMemberRole(
              companyIds[0],
              existingAdmin._id,
            );

            if (adminData?.role != USER_ROLE.ADMIN) {
              result.errors.push(
                `Admin from companyCam already exists in RelayCam with a different role unable to import the data`,
              );
              result.success = false;
              return result;
            }
            const companyMembers =
              await CompanyHelpers.getCompanyMembers(companyIds);

            // Get all user IDs from company members
            for (const member of companyMembers) {
              const user = await UserHelper.findOne({ _id: member.userId });
              if (user) {
                if (user.email) existingCompanyMembers.add(user.email);
                if (user.phone) existingCompanyMembers.add(user.phone);
              }
            }
          }
        }
      }

      let hasUserConflict = false;
      // Check each user for conflicts (only if they're not in the same company)
      for (const { mapped } of mappedUsers) {
        const { email, phone, name } = mapped;
        let hasEmailConflict = false;
        let hasPhoneConflict = false;
        let existingUser = null;

        // Check email existence
        if (email) {
          existingUser = await UserHelper.findOne({ email });
          if (existingUser && !existingCompanyMembers.has(email)) {
            hasEmailConflict = true;
          }
        }

        // Check phone existence
        if (phone && !existingUser) {
          existingUser = await UserHelper.findOne({ phone });
          if (existingUser && !existingCompanyMembers.has(phone)) {
            hasPhoneConflict = true;
          }
        }

        // Record conflicts only if user exists but is not in the same company
        if (hasEmailConflict && hasPhoneConflict) {
          this.errors.push(
            `${email}, ${phone} already exists in RelayCam for CompanyCam user ${name.first} ${name.last}`,
          );
          hasUserConflict = true;
        } else if (hasEmailConflict) {
          this.errors.push(
            `${email} already exists in RelayCam for CompanyCam user ${name.first} ${name.last}`,
          );
          hasUserConflict = true;
        } else if (hasPhoneConflict) {
          this.errors.push(
            `${phone} already exists in RelayCam for CompanyCam user ${name.first} ${name.last}`,
          );
          hasUserConflict = true;
        }
      }

      if (hasUserConflict) {
        this.errors.push(
          "These user will not be part of the team and the rest will be imported",
        );
      }

      result.errors = [...this.errors];
      return result;
    } catch (error) {
      throw "Failed to verify user data";
    }
  }

  async registerUser(userData: ICompayCamUserFormatted, isAdmin: boolean) {
    try {
      const { name, email, role, userRole, profileImage, companyName } =
        userData;

      let { phone } = userData;

      //checking if mail and phonenumber already exists

      let mailExists, phoneExists;

      if (phone) {
        const [existingEmail, existingphone] = await Promise.all([
          UserHelper.findOne({ email }),
          UserHelper.findOne({ phone }),
        ]);

        mailExists = existingEmail;
        phoneExists = existingphone;
      } else {
        const existingEmail = await UserHelper.findOne({ email });
        mailExists = existingEmail;
      }

      if (mailExists) {
        if (isAdmin) {
          throw new Error(
            `Admin with ${email} has already registered the account, unable to import the data`,
          );
        } else {
          this.errors.push(
            `User with ${email} has already registered the account, creating static user`,
          );
          const createdUser = await this.createStaticUser({
            name,
            profileImage: profileImage || undefined,
            userRole: userRole || undefined,
          });
          return createdUser;
        }
      } else if (phoneExists) {
        phone = "";
      }

      //createing user in firebase
      let firebaseAuthUser: UserRecord;
      if (phone) {
        try {
          const phoneRecord = await firebaseService.findUserByPhone(phone);
          console.log(phoneRecord);
          if (phoneRecord?.uid) {
            await firebaseService.deleteUser(phoneRecord.uid);
          }
        } catch (er) {
          /* empty */
        }
      }

      try {
        const record = await firebaseService.findUser(email);

        if (!record) {
          firebaseAuthUser = await firebaseService.createUser(
            name,
            email,
            phone,
          );
        } else {
          firebaseAuthUser = record;
        }
      } catch (err) {
        if (err.code == "auth/user-not-found") {
          firebaseAuthUser = await firebaseService.createUser(
            name,
            email,
            phone,
          );
        }
      }

      const { uid } = firebaseAuthUser;

      await firebaseService.updateUserPhone(uid, phone);

      const obj: CreateUserPayload = {
        email,
        firebaseUid: uid,
        name,
        profileImage,
      };

      if (phone) {
        obj.phone = phone;
      }

      if (companyName) {
        obj.companyName = companyName;
      }

      if (role === COMPANY_CAM_USER_ROLE.ADMIN) {
        obj.roles = USER_ROLE.ADMIN;
      }

      if (userRole) {
        obj.userRole = userRole;
      }

      return UserHelper.create(obj);
    } catch (error) {
      console.log(error);
      throw "Failed to register user";
    }
  }

  async createCompanyInCrewCam(companyName: string, adminUserId: ObjectIdType) {
    try {
      return CompanyHelpers.createCompanyWithAdminUser(
        companyName,
        adminUserId,
      );
    } catch (error) {
      throw "Failed to Create company in crewcam";
    }
  }

  async addUserToCompany(
    companyId: ObjectIdType,
    userId: ObjectIdType,
    role: string,
  ) {
    try {
      let assignedRole: USER_ROLE;

      switch (role) {
        case COMPANY_CAM_USER_ROLE.ADMIN:
          assignedRole = USER_ROLE.MANAGER;
          break;
        case COMPANY_CAM_USER_ROLE.RESTRICTED:
          assignedRole = USER_ROLE.LIMITED;
          break;
        default:
          // Try to map the role to USER_ROLE enum, fallback to LIMITED
          assignedRole =
            USER_ROLE[role.toUpperCase() as keyof typeof USER_ROLE] ||
            USER_ROLE.LIMITED;
          break;
      }

      return CompanyHelpers.addUserToCompany(companyId, userId, assignedRole);
    } catch (error) {
      throw "Failed To add users to company";
    }
  }

  async syncTagsForProject(
    companyCamProjectId: string,
    crewCamProjectId: ObjectIdType,
    companyId: ObjectIdType,
  ): Promise<void> {
    try {
      const tags = await this.client.getProjectTags(companyCamProjectId);

      await syncTagsToProject(
        crewCamProjectId,
        tags.map((t) => t.display_value),
        companyId,
      );
    } catch (error) {
      throw "Failed to sync Tags For projects";
    }
  }

  async syncNotesForProject(
    companyCamProjectId: string,
    crewCamProjectId: ObjectIdType,
    companyCamToCrewCamUserMap: Map<string, ObjectIdType>,
  ): Promise<void> {
    try {
      const notes = await this.client.getProjectNotes(companyCamProjectId);

      for (const note of notes) {
        const newNote = {
          note: note.content,
          projectId: crewCamProjectId,
          userId:
            companyCamToCrewCamUserMap.get(note.creator_id) ||
            companyCamToCrewCamUserMap.get("admin")!, // Fallback to admin user if creator not found
          createdAt: new Date(note.created_at * 1000),
          updatedAt: new Date(note.updated_at * 1000),
        };
        await ProjectNotesHelper.create(newNote);
      }
    } catch (error) {
      throw "Failed to sync Notes";
    }
  }

  async syncProjectFiles(
    companyCamProjectId: string,
    crewCamProjectId: ObjectIdType,
    companyId: ObjectIdType,
    companyCamToCrewCamUserMap: Map<string, ObjectIdType>,
  ): Promise<void> {
    try {
      const files = await this.client.getAllProjectFiles(companyCamProjectId);

      for (const file of files) {
        const formattedFile =
          await this.mapper.mapCompanyCamFileToCrewCamFile(file);
        await FilesHelper.create({
          companyId,
          projectId: crewCamProjectId,
          userId:
            companyCamToCrewCamUserMap.get(file.creator_id) ||
            companyCamToCrewCamUserMap.get("admin")!,
          ...formattedFile,
        });
      }
    } catch (error) {
      throw "Failed to sync project files";
    }
  }

  async syncProjectPosts(
    companyCamProjectId: string,
    crewCamProjectId: ObjectIdType,
    crewCamCompanyId: ObjectIdType,
    companyCamToCrewCamUserMap: Map<string, ObjectIdType>,
  ): Promise<number> {
    try {
      const posts = await this.client.getAllProjectPosts(companyCamProjectId);
      const BATCH_SIZE = 50; // Process 50 photos at a time

      // Process posts in batches
      for (let i = 0; i < posts.length; i += BATCH_SIZE) {
        const batch = posts.slice(i, Math.min(i + BATCH_SIZE, posts.length));

        console.log(
          `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(posts.length / BATCH_SIZE)} (${batch.length} photos)`,
        );

        // Process each batch in parallel
        await Promise.all(
          batch.map(async (post) => {
            try {
              const newPost =
                await this.mapper.mapCompanyCamPhotosToCrewCamPosts(
                  post,
                  [], // Empty tag IDs array
                );

              await PostsHelper.createNow({
                ...newPost,
                projectId: crewCamProjectId,
                companyId: crewCamCompanyId,
                userId:
                  companyCamToCrewCamUserMap.get(post.creator_id) ||
                  companyCamToCrewCamUserMap.get("admin")!,
              });

              // Uncomment if you want to sync comments as well
              // await this.syncPhotoComments(
              //   post.id,
              //   createdPost._id,
              //   companyCamToCrewCamUserMap,
              // );
            } catch (photoError) {
              console.error(`Failed to sync photo ${post.id}:`, photoError);
              // Continue processing other photos even if one fails
              this.errors.push(
                `Failed to sync photo ${post.id}: ${photoError}`,
              );
            }
          }),
        );

        // Optional: Add a small delay between batches to avoid overwhelming the database
        if (i + BATCH_SIZE < posts.length) {
          await delay(100); // Small delay between batches
        }
      }

      return posts.length;
    } catch (error) {
      console.log(error);
      throw "Failed to sync Project posts";
    }
  }

  async syncPhotoComments(
    companyCamPostId: string,
    crewCamPostId: ObjectIdType,
    companyCamToCrewCamUserMap: Map<string, ObjectIdType>,
  ) {
    try {
      const comments = await this.client.getPhotoComments(companyCamPostId);

      const formattedComments = comments.map((comment) => ({
        comment: comment.content,
        userId:
          companyCamToCrewCamUserMap.get(comment.creator_id) ||
          companyCamToCrewCamUserMap.get("admin")!, // Fallback to admin user if creator not found
        createdAt: new Date(comment.created_at * 1000),
        postId: crewCamPostId,
      }));

      await CommentHelper.insertMany(formattedComments);
    } catch (error) {
      throw "Failed to sync photo comments";
    }
  }

  async syncChecklistsForProject(
    companyCamProjectId: string,
    crewCamProjectId: ObjectIdType,
    companyId: ObjectIdType,
    companyCamToCrewCamUserMap: Map<string, ObjectIdType>,
  ): Promise<void> {
    try {
      const checklists =
        await this.client.getProjectChecklists(companyCamProjectId);

      for (const checklist of checklists) {
        const createdChecklist =
          await ChecklistHelper.createChecklistFromCompanyCam({
            userId:
              companyCamToCrewCamUserMap.get(checklist.creator_id) ||
              companyCamToCrewCamUserMap.get("admin")!,
            projectId: crewCamProjectId,
            name: checklist.name,
            type: CHECKLIST_TYPE.CHECKLIST,
            contributors: [],
            companyId,
            createdAt: new Date(checklist.created_at * 1000),
            updatedAt: new Date(checklist.updated_at * 1000),
          });

        const todoListItems = this.mapper.mapChecklistSectionsIntoTodos(
          createdChecklist._id,
          checklist,
          companyCamToCrewCamUserMap,
        );

        const withImages: FormattedTodos[] = [];
        await ChecklistHelper.insertTodoLists(
          todoListItems.filter((todo) => {
            if (todo?.photos?.length) {
              withImages.push(todo);
              return false;
            }
            return true;
          }),
        );

        await Promise.all(
          withImages.map(async (todo) => {
            const newTodo = await ChecklistHelper.createTodoList(todo);

            const formattedImageData = await Promise.all(
              todo?.photos.map(async (photo) => {
                const imageUrl = await this.mapper.mapCompanyCamUrlToCrewCamUrl(
                  photo.url,
                );
                return {
                  checklistId: createdChecklist._id,
                  todoListId: newTodo._id,
                  imageData: {
                    url: imageUrl,
                    fileType: this.mapper.getFileTypeFromUrl(imageUrl),
                    uploadedAt: photo.uploaded_at,
                  },
                };
              }),
            );
            await ChecklistHelper.todoUpdateImages(formattedImageData);
          }),
        );

        const contributors: Set<ObjectIdType> = new Set();

        todoListItems.forEach((todo) => {
          if (todo?.completedBy) {
            contributors.add(todo.completedBy);
          }
        });

        await ChecklistHelper.addContributorsToChecklist(
          createdChecklist._id,
          Array.from(contributors),
        );
      }
    } catch (error) {
      throw "Failed to sync checklists for projects";
    }
  }

  async syncProjectMembers(
    companyCamProjectId: string,
    crewCamProjectId: ObjectIdType,
    companyCamToCrewCamUserMap: Map<string, ObjectIdType>,
  ) {
    try {
      const users = await this.client.getProjectMembers(companyCamProjectId);
      const projectMembers = new Set<ObjectIdType>();

      projectMembers.add(companyCamToCrewCamUserMap.get("admin")!);

      users.forEach((user) => {
        const userId = companyCamToCrewCamUserMap.get(user.id);
        userId && projectMembers.add(userId);
      });

      const memberArray = Array.from(projectMembers);
      for (const userId of memberArray) {
        await ProjectHelper.addToProject(crewCamProjectId, userId);
      }
    } catch (error) {
      throw "Failed to sync project members";
    }
  }
}
