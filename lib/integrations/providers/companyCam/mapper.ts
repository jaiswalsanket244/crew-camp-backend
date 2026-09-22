import * as striptags from "striptags";
import { fileService } from "../../../services/awsBucket";
import { getAddressFromCoordinates } from "../../../services/google";
import {
  CompanyCamChecklist,
  CompanyCamChecklistSection,
  CompanyCamChecklistSubTask,
  CompanyCamChecklistTask,
  CompanyCamFormattedFiles,
  CompanyCamFormattedPhoto,
  CompanyCamFormattedProject,
  CompanyCamPhotos,
  CompanyCamProjectFiles,
  CompanyCamProjects,
  CompanyCamUser,
  FormattedQuestions,
  FormattedTodos,
  ICompayCamUserFormatted,
} from "../../../utils/interfaces/integrations";
import { FileAccessType } from "../../../utils/enums/files";
import { ObjectIdType } from "../../../utils/interfaces/schemaInterface";
import { CHECKLIST_STATUS } from "../../../utils/enums/checklist";
import { COMPANY_CAM_SUB_TASK_ANSWER_TYPE } from "../../../utils/enums/integrations";

export class CompanyCamMapper {
  private countryCode: string;

  constructor(countryCode: string) {
    this.countryCode = countryCode;
  }

  formatPhoneNumber(phoneNumber: string): string {
    // Remove non-digit characters
    const digits = phoneNumber.replace(/\D/g, "");

    return this.countryCode + digits.slice(-10); // Keep only the last 10 digits and prepend country code
  }

  getFileTypeFromUrl(url: string): string {
    const extension = url.split(".").pop()?.toLowerCase();
    const imageExtensions = [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp",
      "bmp",
      "svg",
      "ico",
    ];
    const videoExtensions = [
      "mp4",
      "mov",
      "avi",
      "wmv",
      "flv",
      "mkv",
      "webm",
      "m4v",
    ];

    if (imageExtensions.includes(extension || "")) {
      return "image";
    } else if (videoExtensions.includes(extension || "")) {
      return "video";
    }
    return "image"; // Default to image if unknown
  }

  async mapCompanyCamUserToCrewCamUser(
    companyCamUser: CompanyCamUser,
    companyName: string,
  ): Promise<ICompayCamUserFormatted> {
    return {
      email: companyCamUser.email_address.toLowerCase().trim(),
      name: {
        first: companyCamUser.first_name,
        last: companyCamUser.last_name,
      },
      phone: this.formatPhoneNumber(companyCamUser.phone_number),
      role: companyCamUser.user_role,
      userRole: "",
      profileImage: companyCamUser.profile_image?.[0]?.url
        ? await fileService.uploadFromUrl(companyCamUser.profile_image[0].url)
        : "",
      companyName,
      // Map other fields as needed
    };
  }

  async mapCompanyCamProjectToCrewCamProject(
    companyCamProject: CompanyCamProjects,
  ): Promise<CompanyCamFormattedProject> {
    const formattedData: CompanyCamFormattedProject = {
      creator_id: companyCamProject.creator_id,
      name: companyCamProject.name || "Untitled Project",
      description: companyCamProject.notepad
        ? striptags(companyCamProject.notepad)
        : "",
      location: await getAddressFromCoordinates(
        companyCamProject.coordinates.lat,
        companyCamProject.coordinates.lon,
      ),
      coordinates: {
        latitude: companyCamProject.coordinates.lat,
        longitude: companyCamProject.coordinates.lon,
      },
      createdAt: new Date(companyCamProject.created_at * 1000),
      updatedAt: new Date(companyCamProject.updated_at * 1000),
      externalMapping: { externalId: companyCamProject.id },
      // Map other fields as needed
    };

    if (companyCamProject.archived) {
      formattedData.archivedAt = new Date();
    }

    return formattedData;
  }

  async mapCompanyCamFileToCrewCamFile(
    CompanyCamFile: CompanyCamProjectFiles,
  ): Promise<CompanyCamFormattedFiles> {
    return {
      name: CompanyCamFile.name,
      fileType: CompanyCamFile.content_type,
      size: Number((CompanyCamFile.byte_size / 1024).toFixed(2)),
      url:
        (await fileService.uploadFromUrl(CompanyCamFile.url)) ||
        CompanyCamFile.url,
      accessLevel: FileAccessType.PUBLIC,
      createdAt: new Date(CompanyCamFile.created_at * 1000),
      updatedAt: new Date(CompanyCamFile.updated_at * 1000),
    };
  }

  async mapCompanyCamPhotosToCrewCamPosts(
    companyCamPhoto: CompanyCamPhotos,
    tags: ObjectIdType[],
  ): Promise<CompanyCamFormattedPhoto> {
    return {
      note: companyCamPhoto?.description?.plain_text_content
        ? striptags(companyCamPhoto.description.plain_text_content)
        : "",
      files: [
        {
          url:
            (await fileService.uploadFromUrl(companyCamPhoto.uris[0].url)) ||
            companyCamPhoto.uris[0].url,
          fileType: this.getFileTypeFromUrl(companyCamPhoto.uris[0].url),
          uploadedAt: new Date(companyCamPhoto.captured_at * 1000),
          size: {
            width: 1,
            height: 1,
          },
          location: {
            long: companyCamPhoto.coordinates?.lon,
            lat: companyCamPhoto.coordinates?.lat,
          },
          timestamp: new Date(companyCamPhoto.created_at),
          tags,
        },
      ],
      createdAt: new Date(companyCamPhoto.created_at * 1000),
      externalCompanyCamPostId: companyCamPhoto.id,
    };
  }

  mapChecklistQuestionAndAnswer(
    subTask: CompanyCamChecklistSubTask[],
  ): FormattedQuestions[] {
    return subTask.map((question) => ({
      label: question?.label,
      value:
        question.answer_type === COMPANY_CAM_SUB_TASK_ANSWER_TYPE.OPEN_TEXT
          ? question.answer_text || ""
          : question.answer_choices?.length
            ? question.answer_options[question.answer_choices[0]] || ""
            : "",
    }));
  }

  mapchecklistSectionlessTasks(
    checklistId: ObjectIdType,
    tasks: CompanyCamChecklistTask[],
    companyCamToCrewCamUserMap: Map<string, ObjectIdType>,
  ): FormattedTodos[] {
    return tasks.map((task, index) => ({
      checklistId,
      name: task.title,
      description: task.details,
      status: task.completed_at
        ? CHECKLIST_STATUS.COMPLETED
        : CHECKLIST_STATUS.PENDING,
      createdAt: new Date(task.created_at * 1000),
      updatedAt: new Date(task.updated_at * 1000),
      completedBy: task.completed_at
        ? companyCamToCrewCamUserMap.get(task.completed_by_id) ||
          companyCamToCrewCamUserMap.get("admin")!
        : null,
      completedAt: task.completed_at
        ? new Date(task.completed_at * 1000)
        : null,
      sortOrder: index,
      areImagesMandatory: !!task.photo_capture_required,
      questions: this.mapChecklistQuestionAndAnswer(task.sub_tasks || []),
      photos: task.photos || [], // Ensure it's an array
    }));
  }

  mapchecklistSectionTasks(
    checklistId: ObjectIdType,
    sections: CompanyCamChecklistSection[],
    companyCamToCrewCamUserMap: Map<string, ObjectIdType>,
  ): FormattedTodos[] {
    const formattedTasks = [];

    for (const section of sections) {
      for (const task of section.tasks) {
        formattedTasks.push({
          checklistId,
          name:
            (section?.title?.trim() || "") + "-" + (task?.title?.trim() || ""),
          description: task.details,
          status: task.completed_at
            ? CHECKLIST_STATUS.COMPLETED
            : CHECKLIST_STATUS.PENDING,
          createdAt: new Date(task.created_at * 1000),
          updatedAt: new Date(task.updated_at * 1000),
          completedBy: task.completed_at
            ? companyCamToCrewCamUserMap.get(task.completed_by_id) ||
              companyCamToCrewCamUserMap.get("admin")!
            : null,
          completedAt: task.completed_at
            ? new Date(task.completed_at * 1000)
            : null,
          sortOrder: 0,
          areImagesMandatory: !!task.photo_capture_required,
          questions: this.mapChecklistQuestionAndAnswer(task.sub_tasks || []),
          photos: task.photos || [], // Ensure it's an array
        });
      }
    }

    return formattedTasks;
  }

  mapChecklistSectionsIntoTodos(
    checklistId: ObjectIdType,
    checklist: CompanyCamChecklist,
    companyCamToCrewCamUserMap: Map<string, ObjectIdType>,
  ): FormattedTodos[] {
    const sectionLess = this.mapchecklistSectionlessTasks(
      checklistId,
      checklist.sectionless_tasks,
      companyCamToCrewCamUserMap,
    );
    const sections = this.mapchecklistSectionTasks(
      checklistId,
      checklist.sections,
      companyCamToCrewCamUserMap,
    );
    return [...sectionLess, ...sections].map((todo, index) => ({
      ...todo,
      sortOrder: index,
    }));
  }

  mapCompanyCamUrlToCrewCamUrl(url: string) {
    return fileService.uploadFromUrl(url);
  }
}
