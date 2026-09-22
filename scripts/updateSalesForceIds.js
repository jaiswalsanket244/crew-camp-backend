// const updateSalesForceLeadId = async () => {
//   try {
//     const companies = await Company.find({}, { userId: 1 });
//     const adminUserIds = companies.map((company) => company.userId);
//     const users = await User.find(
//       { salesforceLeadId: { $exists: false }, _id: { $in: adminUserIds } },
//       { _id: 1, email: 1 },
//     );
//     for (let userData of users) {
//       const leadId = await SalesForceService.findleadId(
//         userData._id,
//         userData.email,
//       );
//     }
//     console.log("Salesforce leadId updated successfully for all users");
//   } catch (er) {
//     console.log(er);
//   }
// };
// updateSalesForceLeadId();
