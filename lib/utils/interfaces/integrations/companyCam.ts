import { CHECKLIST_STATUS, CHECKLIST_TYPE } from "../../enums/checklist";
import { FileAccessType } from "../../enums/files";
import {
  COMPANY_CAM_SUB_TASK_ANSWER_TYPE,
  COMPANY_CAM_USER_ROLE,
} from "../../enums/integrations";
import { ObjectIdType } from "../schemaInterface";

// CompanyCam API Types
export interface CompanyCamOrganization {
  id: string;
  name: string;
}

export interface CompanyCamUser {
  id: string;
  email_address: string;
  first_name: string;
  last_name: string;
  profile_image: [
    {
      type: string;
      uri: string;
      url: string;
    },
  ];
  status: "active" | "deleted";
  phone_number: string;
  user_role: COMPANY_CAM_USER_ROLE;
}

export interface ICompayCamUserFormatted {
  email: string;
  name: {
    first: string;
    last: string;
  };
  phone: string;
  role: COMPANY_CAM_USER_ROLE;
  userRole: string;
  profileImage: string | null;
  companyName: string;
}

export interface CompanyCamProject {
  id: string;
  name: string;
  status: "active" | "archived" | "deleted";
  public_id?: string;
  address?: {
    street_address_1?: string;
    street_address_2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    country?: string;
  };
  coordinates?: {
    lat: number;
    lon: number;
  };
  geofence?: {
    radius: number;
    coordinates: {
      lat: number;
      lon: number;
    };
  };
  creator?: {
    id: string;
    email: string;
    first_name?: string;
    last_name?: string;
    display_name?: string;
  };
  featured_image?: {
    uri: string;
    uri_medium: string;
    uri_large: string;
  };
  contacts?: Array<{
    id: string;
    name?: string;
    email?: string;
    phone?: string;
  }>;
  created_at: string;
  updated_at: string;
  photo_count?: number;
  tags?: string[];
}

export interface CompanyCamPhoto {
  id: string;
  project_id: string;
  uri: string;
  uri_original: string;
  uri_medium?: string;
  uri_large?: string;
  uri_thumbnail?: string;
  creator?: {
    id: string;
    email: string;
    display_name?: string;
  };
  coordinates?: {
    lat: number;
    lon: number;
  };
  comments?: Array<{
    id: string;
    content: string;
    user: {
      id: string;
      display_name: string;
    };
    created_at: string;
  }>;
  tags?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  created_at: string;
  updated_at: string;
  captured_at?: string;
  internal_note?: string;
  description?: string;
}

export interface CompanyCamListResponse<T> {
  data: T[];
  meta?: {
    current_page: number;
    last_page: number;
    per_page: number;
    total: number;
  };
}

export interface ImportResult {
  success: boolean;
  projectsImported: number;
  photosImported: number;
  errors: string[];
  details: {
    projects: Array<{
      companyCamId: string;
      crewCamId: string;
      name: string;
      photoCount: number;
    }>;
  };
  failedProjects?: Array<{
    projectId: string;
    projectName: string;
    error: string;
  }>;
}

export interface VerifyResult {
  success: boolean;
  errors: string[];
}

export interface CompanyCamProjects {
  id: string;
  status: "active" | "archived" | "deleted";
  creator_id: string;
  archived: boolean;
  name: string;
  coordinates: {
    lat: number;
    lon: number;
  };
  notepad: string | null;
  created_at: number;
  updated_at: number;
}

export interface CompanyCamFormattedProject {
  creator_id: string;
  name: string;
  description: string;
  location: string;
  coordinates: {
    latitude: number;
    longitude: number;
  };
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  externalMapping: {
    externalId: string;
  };
  // Map other fields as needed
}

export interface CompanyCamProjectLabels {
  id: string;
  company_id: string;
  display_value: string;
  value: string;
  created_at: number;
  updated_at: number;
  tag_type: string;
}

export interface CompanyCamProjectNotes {
  id: string;
  commentable_id: string;
  commentable_type: string;
  status: string;
  content: string;
  creator_id: string;
  creator_type: string;
  creator_name: string;
  created_at: number;
  updated_at: number;
}

export interface CompanyCamProjectFiles {
  id: string;
  company_id: string;
  byte_size: number;
  content_type: string;
  creator_id: string;
  creator_type: string;
  creator_name: string;
  project_id: string;
  name: string;
  url: string;
  created_at: number;
  updated_at: number;
}

export interface CompanyCamFormattedFiles {
  name: string;
  fileType: string;
  size: number;
  url: string;
  accessLevel: FileAccessType;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyCamPhotos {
  id: string;
  company_id: string;
  creator_id: string;
  creator_type: string;
  creator_name: string;
  project_id: string;
  coordinates: {
    lat: number;
    lon: number;
  };
  status: string;
  uris: [
    {
      type: string;
      uri: string;
      url: string;
    },
  ];
  captured_at: number;
  created_at: number;
  updated_at: number;
  processing_status: string;
  description: {
    id: string;
    html_content: string;
    plain_text_content: string;
  } | null;
}

export interface CompanyCamFormattedPhoto {
  note: string;
  files: [
    {
      url: string;
      fileType: string;
      uploadedAt: Date;
      size: {
        width: number;
        height: number;
      };
      location: {
        long: number;
        lat: number;
      };
      timestamp: Date;
      tags: ObjectIdType[];
    },
  ];
  createdAt: Date;
  externalCompanyCamPostId?: string;
}

export interface CompanyCamComments {
  id: string;
  commentable_id: string;
  commentable_type: string;
  status: string;
  content: string;
  creator_id: string;
  creator_type: string;
  creator_name: string;
  created_at: number;
  updated_at: number;
}

//checklist photos type
export interface CheckListPhotos {
  creator: string;
  uploaded_at: string;
  url: string;
}
// Checklist Sub-task Types
export interface CompanyCamChecklistSubTask {
  id: string;
  label: string;
  answer_type: COMPANY_CAM_SUB_TASK_ANSWER_TYPE;
  answer_options: string[];
  position: number;
  task_id: number;
  answer_text: string | null;
  answer_choices: number[];
}

// Checklist Task Types
export interface CompanyCamChecklistTask {
  id: string;
  completed_at: number | null;
  completed_by_id: string;
  completed_by_type: string | null;
  created_at: number;
  creator_id: string;
  creator_type: string;
  details: string;
  photo_capture_required: boolean;
  position: number;
  todo_list_id: string;
  todo_list_section_id: string;
  title: string;
  updated_at: number;
  photos: CheckListPhotos[]; // Can be further typed if photo structure is known
  sub_tasks: CompanyCamChecklistSubTask[];
}

// Checklist Section Types
export interface CompanyCamChecklistSection {
  id: string;
  todo_list_id: string;
  creator_id: string;
  creator_type: string;
  creator_name: string;
  title: string;
  position: number;
  tasks: CompanyCamChecklistTask[];
  created_at: number;
  updated_at: number;
}

// Main Checklist Type
export interface CompanyCamChecklist {
  id: string;
  company_id: string;
  project_id: string;
  creator_id: string;
  creator_name: string;
  name: string;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  checklist_template_id: string | null;
  is_populating: boolean | null;
  sectionless_tasks: CompanyCamChecklistTask[];
  sections: CompanyCamChecklistSection[];
}

export interface FormattedQuestions {
  label: string;
  value: string;
}

export interface FormattedTodos {
  checklistId: ObjectIdType;
  name: string;
  description: string;
  status: CHECKLIST_STATUS;
  createdAt: Date;
  updatedAt: Date;
  completedBy: ObjectIdType | null;
  completedAt: Date | null;
  sortOrder: number;
  areImagesMandatory: boolean;
  questions: FormattedQuestions[];
  photos: CheckListPhotos[];
}

export interface FormattedChecklist {
  userId: ObjectIdType;
  projectId: ObjectIdType;
  name: string;
  type: CHECKLIST_TYPE;
  contributors: ObjectIdType[];
  companyId: ObjectIdType;
  createdAt: Date;
  updatedAt: Date;
}
